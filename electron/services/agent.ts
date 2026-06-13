import type { BrowserWindow } from 'electron';
import fs from 'node:fs';
import { workspace } from './workspace.js';
import { appSettings } from './settings.js';
import { aiMutex } from './ai-mutex.js';
import { cdesign } from './cdesign.js';
import { terminal } from './terminal.js';
import { brain } from './brain.js';
import { providers } from './providers.js';
import { mcp } from './mcp.js';
import {
  type AgentMessage,
  type ToolCall,
  collapseOldToolResults,
  escapeXml,
  findCompletedToolCall,
  findSafeTextBoundary,
  looksLikeToolIntentWithoutCall,
  readField,
} from './agent-protocol.js';

/**
 * Agent loop: gives a local Ollama (or any text) model a set of tools to read,
 * list, edit and create files in the user's workspace.
 *
 * Wire protocol (model-facing): the model emits XML-like tool blocks, e.g.
 *
 *   <tool name="read_file">
 *   <path>src/components/Button.tsx</path>
 *   </tool>
 *
 * The agent intercepts complete blocks in the stream, executes the tool,
 * appends a <tool_result> message and continues generation. Up to MAX_STEPS
 * iterations to avoid runaway loops.
 *
 * Renderer event ('agent:chunk') payloads:
 *   { requestId, kind: 'text',        chunk, done? }
 *   { requestId, kind: 'tool_call',   tool, args, status: 'running' }
 *   { requestId, kind: 'tool_result', tool, ok, summary, error? }
 *   { requestId, kind: 'done',        done: true, error? }
 */

function ollamaUrl(): string {
  return appSettings.get().provider.ollama.baseUrl.replace(/\/+$/, '');
}

interface AgentParams {
  model: string;
  messages: AgentMessage[];
  system?: string;
  workspaceRoot: string | null;
  requestId: string;
  /** Provider id: 'ollama' (default, local) or any cloud provider from
   *  providers.ts ('anthropic', 'openrouter', 'groq', 'nvidia', ...). */
  provider?: string;
  /** When false, skip the auto "what was done" worklog entry (callers like
   *  multyplan log a single consolidated entry themselves). Default: true. */
  logWorklog?: boolean;
}

/**
 * Per-request live state. The entry exists for the WHOLE agent.chat() run
 * (not just while a stream turn is in flight) so that an abort arriving
 * between turns — e.g. while a tool executes — is never lost: it raises
 * `userAborted`, which the loop checks at every boundary.
 */
interface ActiveRequest {
  controller: AbortController | null;
  userAborted: boolean;
}

const activeRequests = new Map<string, ActiveRequest>();

function abortRequest(requestId: string): boolean {
  const st = activeRequests.get(requestId);
  if (!st) return false;
  st.userAborted = true;
  try {
    st.controller?.abort();
  } catch {
    /* ignore */
  }
  return true;
}

interface ToolResult {
  ok: boolean;
  summary: string;
  error?: string;
  /** What gets fed back to the model as <tool_result> body. */
  modelText: string;
}

async function executeTool(
  name: string,
  block: string,
  workspaceRoot: string | null,
  win: BrowserWindow,
  requestId: string,
  readFiles: Set<string>
): Promise<ToolResult> {
  // Notify UI: tool call started
  const argsPreview: Record<string, string> = {};
  for (const f of ['path', 'query', 'command', 'old_string', 'new_string', 'replace_all', 'content', 'offset', 'limit', 'server', 'tool']) {
    const v = readField(block, f);
    if (v != null) argsPreview[f] = v.length > 80 ? v.slice(0, 80) + '…' : v;
  }
  win.webContents.send('agent:chunk', {
    requestId,
    kind: 'tool_call',
    tool: name,
    args: argsPreview,
    status: 'running',
  });

  const pathArg = readField(block, 'path');
  const resolved = pathArg
    ? workspace.resolveAgentPath(pathArg, workspaceRoot)
    : { ok: true as const };

  if (pathArg && !resolved.ok) {
    return {
      ok: false,
      summary: resolved.error || 'bad path',
      modelText: `ERROR: ${resolved.error}`,
      error: resolved.error,
    };
  }

  try {
    switch (name) {
      case 'read_file': {
        if (!pathArg) return failTool('read_file требует <path>');
        const res = await workspace.readFile(resolved.absolute!);
        if (!res.ok) return failTool(res.error || 'read failed');
        const content = res.content || '';
        const lines = content.split('\n');
        const total = lines.length;

        // Optional windowed read: <offset> (1-based line) + <limit> (lines).
        const offsetRaw = readField(block, 'offset');
        const limitRaw = readField(block, 'limit');
        const offset = Math.min(
          Math.max(1, offsetRaw ? Math.floor(Number(offsetRaw)) || 1 : 1),
          total
        );
        const limit = limitRaw
          ? Math.max(1, Math.floor(Number(limitRaw)) || total)
          : total;
        const slice = lines.slice(offset - 1, offset - 1 + limit);

        // Char budget per read: never blow up the context. Cut on a line
        // boundary and tell the model the exact offset to continue from.
        const CAP = 30_000;
        let body = slice.join('\n');
        let shownCount = slice.length;
        if (body.length > CAP) {
          let acc = 0;
          let cut = 0;
          for (let i = 0; i < slice.length; i++) {
            acc += slice[i].length + 1;
            if (acc > CAP && cut > 0) break;
            cut = i + 1;
          }
          shownCount = Math.max(1, cut);
          body = slice.slice(0, shownCount).join('\n');
        }
        const lastLine = offset - 1 + shownCount;
        const hasMore = lastLine < total;

        readFiles.add(pathArg);
        if (resolved.absolute) readFiles.add(resolved.absolute);

        return {
          ok: true,
          summary: `Прочитаны строки ${offset}–${lastLine} из ${total}`,
          modelText:
            `<file path="${escapeXml(pathArg)}" lines="${offset}-${lastLine}" total_lines="${total}">\n${body}\n</file>` +
            (hasMore
              ? `\n[Файл показан НЕ полностью (${lastLine}/${total} строк). Чтобы дочитать, вызови read_file ещё раз с <offset>${lastLine + 1}</offset>.]`
              : ''),
        };
      }

      case 'search': {
        const query = readField(block, 'query') || readField(block, 'pattern');
        if (!query) return failTool('search требует <query>');
        const inPath = readField(block, 'path') || undefined;
        const res = await workspace.search(query, inPath ? { path: inPath } : {});
        if (!res.ok) return failTool(res.error || 'search failed');
        const hits = res.matches || [];
        const lines = hits.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n');
        return {
          ok: true,
          summary: `${hits.length} совпадений в ${res.filesScanned ?? 0} файлах${
            res.truncated ? ' (обрезано)' : ''
          }`,
          modelText:
            lines +
            (res.truncated ? '\n[... результаты обрезаны, уточни запрос ...]' : '') ||
            '(ничего не найдено)',
        };
      }

      case 'list_dir': {
        const target = pathArg
          ? resolved.absolute!
          : workspaceRoot
          ? workspaceRoot
          : '';
        if (!target) return failTool('list_dir: проект не открыт');
        const res = await workspace.listDirectory(target);
        if (!res.ok) return failTool(res.error || 'list failed');
        const lines = (res.entries || [])
          .map((e) => `${e.isDir ? 'D' : 'F'} ${e.name}`)
          .join('\n');
        return {
          ok: true,
          summary: `${res.entries?.length || 0} элементов`,
          modelText: lines || '(пусто)',
        };
      }

      case 'edit_file': {
        if (!pathArg) return failTool('edit_file требует <path>');
        // Anti-hallucination guard: refuse to edit a file the model has not
        // actually read in THIS task — old_string written from memory is the
        // #1 source of broken edits.
        if (!readFiles.has(pathArg) && !(resolved.absolute && readFiles.has(resolved.absolute))) {
          return failTool(
            `Сначала прочитай файл (read_file ${pathArg}) — правки без чтения запрещены.`
          );
        }
        const oldStr = readField(block, 'old_string');
        const newStr = readField(block, 'new_string');
        const replaceAllRaw = readField(block, 'replace_all');
        if (oldStr == null || newStr == null) {
          return failTool('edit_file требует <old_string> и <new_string>');
        }
        const replaceAll = replaceAllRaw != null && /true|1|yes/i.test(replaceAllRaw.trim());
        const res = await workspace.applyEdit(resolved.absolute!, oldStr, newStr, replaceAll);
        if (!res.ok) return failTool(res.error || 'edit failed');
        return {
          ok: true,
          summary: `Изменено в ${pathArg} (${res.replacements} замен)`,
          modelText: `OK: заменено ${res.replacements} вхождений в ${pathArg}`,
        };
      }

      case 'create_file': {
        if (!pathArg) return failTool('create_file требует <path>');
        const content = readField(block, 'content');
        if (content == null) return failTool('create_file требует <content>');
        // Overwriting an existing file without reading it first is a silent
        // data-loss vector — require read_file or edit_file instead.
        if (
          resolved.absolute &&
          fs.existsSync(resolved.absolute) &&
          !readFiles.has(pathArg) &&
          !readFiles.has(resolved.absolute)
        ) {
          return failTool(
            `Файл ${pathArg} уже существует. Сначала прочитай его (read_file), затем используй edit_file для точечных правок.`
          );
        }
        const res = await workspace.createFile(resolved.absolute!, content);
        if (!res.ok) return failTool(res.error || 'create failed');
        return {
          ok: true,
          summary: `Создан ${pathArg} (${content.length} симв.)`,
          modelText: `OK: создан файл ${pathArg}`,
        };
      }

      case 'delete_file': {
        if (!pathArg) return failTool('delete_file требует <path>');
        const res = await workspace.deleteFile(resolved.absolute!);
        if (!res.ok) return failTool(res.error || 'delete failed');
        return {
          ok: true,
          summary: `Удалён ${pathArg}`,
          modelText: `OK: удалён ${pathArg}`,
        };
      }

      case 'run_command': {
        const cmdText = readField(block, 'command');
        if (!cmdText || !cmdText.trim()) return failTool('run_command requires <command>');
        const cwdField = readField(block, 'cwd');
        const timeoutField = readField(block, 'timeout_ms');
        const timeoutMs = timeoutField ? Number(timeoutField) : undefined;
        const subId = `${requestId}::cmd-${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 7)}`;
        const res = await terminal.run(
          {
            command: cmdText.trim(),
            cwd: cwdField?.trim() || undefined,
            timeoutMs: Number.isFinite(timeoutMs as number) ? (timeoutMs as number) : undefined,
            requestId: subId,
          },
          win
        );
        if (!res.ok) {
          return failTool(
            `${res.error || 'command failed'}${
              res.stderr ? ` — stderr: ${res.stderr.slice(0, 400)}` : ''
            }`
          );
        }
        const stdout = res.stdout || '';
        const stderr = res.stderr || '';
        const summary = `exit ${res.code}, ${stdout.length}b stdout, ${stderr.length}b stderr, ${res.durationMs}ms${
          res.truncated ? ' (truncated)' : ''
        }`;
        const body = [
          `exit_code: ${res.code}`,
          `duration_ms: ${res.durationMs}`,
          stdout ? `\n--- stdout ---\n${stdout}` : '',
          stderr ? `\n--- stderr ---\n${stderr}` : '',
          res.truncated ? '\n[output truncated]' : '',
        ]
          .filter(Boolean)
          .join('\n');
        return { ok: true, summary, modelText: body };
      }

      case 'read_recipe': {
        // cdesign skill recipe lookup. Field is <name>foo</name>, not <path>.
        const recipe = readField(block, 'name') || readField(block, 'recipe');
        if (!recipe) return failTool('read_recipe requires <name>');
        const res = await cdesign.readRecipe(recipe);
        if (!res.ok) return failTool(res.error || 'recipe not found');
        const content = res.content || '';
        return {
          ok: true,
          summary: `cdesign recipe: ${recipe} (${content.length} chars)`,
          modelText: `<recipe name="${escapeXml(recipe)}">\n${content}\n</recipe>`,
        };
      }

      case 'mcp_list_tools': {
        await mcp.sync();
        const tools = mcp.listAllTools();
        if (tools.length === 0) {
          return {
            ok: true,
            summary: 'MCP: инструментов нет',
            modelText:
              'Подключённых MCP-инструментов нет. Пользователь может добавить серверы в Settings → MCP servers.',
          };
        }
        const lines = tools.map(
          (t) =>
            `${t.server} :: ${t.name} — ${t.description || '(без описания)'}` +
            (t.inputSchema ? `\n  args schema: ${JSON.stringify(t.inputSchema).slice(0, 600)}` : '')
        );
        return {
          ok: true,
          summary: `MCP: ${tools.length} инструментов`,
          modelText: lines.join('\n'),
        };
      }

      case 'mcp_call': {
        const server = readField(block, 'server');
        const toolName = readField(block, 'tool');
        const argsRaw = readField(block, 'arguments') ?? readField(block, 'args') ?? '{}';
        if (!server || !toolName) return failTool('mcp_call требует <server> и <tool>');
        let argsJson: any = {};
        try {
          argsJson = argsRaw.trim() ? JSON.parse(argsRaw) : {};
        } catch {
          return failTool('<arguments> должен быть валидным JSON-объектом');
        }
        const res = await mcp.callTool(server, toolName, argsJson);
        if (!res.ok) return failTool(res.error || 'mcp call failed');
        return {
          ok: true,
          summary: `MCP ${server}::${toolName} — OK`,
          modelText: res.text || '(пустой результат)',
        };
      }

      default:
        return failTool(`Неизвестный инструмент: ${name}`);
    }
  } catch (err: any) {
    return failTool(err.message || String(err));
  }
}

function failTool(msg: string): ToolResult {
  return { ok: false, summary: msg, error: msg, modelText: `ERROR: ${msg}` };
}

/** Stream one chat turn (any provider) into a string buffer, optionally aborting mid-stream. */
async function streamOneTurn(
  provider: string,
  model: string,
  messages: AgentMessage[],
  onText: (chunk: string) => void,
  controller: AbortController,
  shouldStop: (buffer: string) => boolean
): Promise<{ ok: boolean; text: string; error?: string }> {
  // Cloud providers (anthropic / openrouter / groq / nvidia / ...): one
  // uniform SSE stream via the providers layer. The XML tool protocol is
  // plain text, so it works with every model.
  if (provider && provider !== 'ollama') {
    let cloudBuffer = '';
    const system = messages.find((m) => m.role === 'system')?.content;
    const rest = messages.filter((m) => m.role !== 'system');
    const res = await providers.streamText({
      providerId: provider,
      model,
      messages: rest,
      system,
      maxTokens: 8192,
      signal: controller.signal,
      onText: (chunk) => {
        cloudBuffer += chunk;
        onText(chunk);
        if (shouldStop(cloudBuffer)) {
          try {
            controller.abort();
          } catch {
            /* ignore */
          }
        }
      },
    });
    if (!res.ok) return { ok: false, text: cloudBuffer, error: res.error };
    return { ok: true, text: cloudBuffer };
  }

  let buffer = '';

  const res = await fetch(`${ollamaUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
    }),
    signal: controller.signal,
  });

  if (!res.ok || !res.body) {
    return { ok: false, text: '', error: `HTTP ${res.status}` };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let lineBuf = '';
  let stopRequested = false;
  const OLLAMA_STALL_MS = 90_000;

  type ReadResult = Awaited<ReturnType<typeof reader.read>>;
  function ollamaReadNext(): Promise<ReadResult> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(Object.assign(new Error('Ollama stream stalled'), { name: 'TimeoutError' })),
        OLLAMA_STALL_MS
      );
      reader.read().then(
        (r) => { clearTimeout(t); resolve(r); },
        (e) => { clearTimeout(t); reject(e); }
      );
    });
  }

  while (true) {
    let done: boolean;
    let value: Uint8Array | undefined;
    try {
      ({ done, value } = await ollamaReadNext());
    } catch (err: any) {
      if (err.name === 'TimeoutError') break;
      throw err;
    }
    if (done) break;
    lineBuf += decoder.decode(value, { stream: true });

    const lines = lineBuf.split('\n');
    lineBuf = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        const chunk: string = data.message?.content || '';
        if (chunk) {
          buffer += chunk;
          onText(chunk);
          if (shouldStop(buffer)) {
            stopRequested = true;
            break;
          }
        }
        if (data.done) break;
      } catch {
        /* skip */
      }
    }

    if (stopRequested) {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
      break;
    }
  }

  return { ok: true, text: buffer };
}

export const agent = {
  async chat(params: AgentParams, win: BrowserWindow): Promise<{ ok: boolean; error?: string }> {
    const { model, messages, system, workspaceRoot, requestId } = params;
    const provider = params.provider || 'ollama';
    const settings = appSettings.get();
    const MAX_STEPS = settings.agent.maxToolCalls;
    const MAX_FILES_TOUCHED = settings.agent.maxFilesPerTask;

    // Acquire the global AI mutex. Subordinate calls (e.g. multyplan's
    // executor stage) re-acquire under the parent requestId, which the mutex
    // accepts (isHeldBy short-circuits).
    const ownsLock = !aiMutex.isHeldBy(requestId);
    const lock = ownsLock
      ? aiMutex.acquire('agent', requestId, () => abortRequest(requestId))
      : { ok: true as const, release: () => {} };
    if (!lock.ok) {
      win.webContents.send('agent:chunk', {
        requestId,
        kind: 'done',
        done: true,
        error: lock.error,
      });
      return { ok: false, error: lock.error };
    }

    // Compose system: caller's system prompt + tool protocol primer.
    const systemFinal = [system, TOOL_PROTOCOL_PROMPT].filter(Boolean).join('\n\n');

    const convo: AgentMessage[] = [
      { role: 'system', content: systemFinal },
      ...messages,
    ];

    const touchedFiles = new Set<string>();
    const readFiles = new Set<string>();

    const send = (payload: any) =>
      win.webContents.send('agent:chunk', { requestId, ...payload });

    // Registered for the whole run so an abort between turns is not lost.
    const reqState: ActiveRequest = { controller: null, userAborted: false };
    activeRequests.set(requestId, reqState);

    let finalError: string | undefined;
    // Corrective steps issued since the last real tool execution. Capped so a
    // model that keeps promising tools in prose ends with a clear error
    // instead of an endless nudge loop or silence.
    const MAX_NUDGES = 2;
    let nudges = 0;

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        if (reqState.userAborted) {
          send({ kind: 'done', done: true, aborted: true });
          return { ok: true };
        }
        const controller = new AbortController();
        reqState.controller = controller;

        // Collapse stale tool dumps before every turn — token economy.
        collapseOldToolResults(convo);

        let assistantBuffer = '';
        let consumedUpto = 0;
        let toolCall: ToolCall | null = null;

        const turn = await streamOneTurn(
          provider,
          model,
          convo,
          (chunk) => {
            assistantBuffer += chunk;
            // Emit only the portion before any open <tool ...> tag we've seen.
            // We don't want the user to see the raw XML being streamed.
            const safeBoundary = findSafeTextBoundary(assistantBuffer, consumedUpto);
            if (safeBoundary > consumedUpto) {
              const visible = assistantBuffer.slice(consumedUpto, safeBoundary);
              consumedUpto = safeBoundary;
              if (visible) send({ kind: 'text', chunk: visible });
            }
          },
          controller,
          (buf) => {
            const found = findCompletedToolCall(buf);
            if (found) {
              toolCall = found;
              return true;
            }
            return false;
          }
        );

        reqState.controller = null;

        if (!turn.ok) {
          finalError = turn.error;
          break;
        }

        if (reqState.userAborted) {
          const remainder = assistantBuffer.slice(consumedUpto);
          if (remainder && !toolCall) send({ kind: 'text', chunk: remainder });
          send({ kind: 'done', done: true, aborted: true });
          return { ok: true };
        }

        if (!toolCall) {
          // No tool call — model produced its final answer. Flush remainder.
          const remainder = assistantBuffer.slice(consumedUpto);
          if (remainder) send({ kind: 'text', chunk: remainder });
          if (looksLikeToolIntentWithoutCall(assistantBuffer) && step < MAX_STEPS - 1) {
            if (nudges >= MAX_NUDGES) {
              // Corrective steps exhausted — finish with an explicit error
              // instead of hanging in silence.
              finalError =
                'модель описала вызов инструмента словами, но не отправила XML-блок <tool> даже после корректирующих шагов';
              send({
                kind: 'text',
                chunk:
                  '\n\n_(модель так и не вызвала инструмент — ответ прерван с ошибкой)_\n',
              });
              break;
            }
            nudges++;
            convo.push({ role: 'assistant', content: assistantBuffer });
            convo.push({
              role: 'user',
              content:
                'Система НЕ выполнила никаких действий: текстовое описание инструмента ничего не запускает, а тег <tool_result> может вставлять только система. Если ты собирался выполнить действие — выведи СЕЙЧАС ровно один XML-блок вида <tool name="...">...</tool> без каких-либо пояснений. Например: <tool name="list_dir"><path>.</path></tool>. Если задача уже полностью решена — дай финальный ответ, не упоминая имена инструментов.',
            });
            send({
              kind: 'text',
              chunk: '\n\n_(модель описала вызов инструмента, но не отправила tool-блок; продолжаю с принудительным вызовом)_\n',
            });
            continue;
          }
          break;
        }

        // We have a tool call. Emit any clean text before it.
        const tc: ToolCall = toolCall;
        const preToolText = assistantBuffer.slice(consumedUpto, tc.startInOutput);
        if (preToolText) send({ kind: 'text', chunk: preToolText });

        // Enforce per-task file touch ceiling.
        const isMutating =
          tc.name === 'edit_file' || tc.name === 'create_file' || tc.name === 'delete_file';
        const pathArg = readField(tc.raw, 'path') || '';
        if (isMutating && pathArg && !touchedFiles.has(pathArg)) {
          if (touchedFiles.size >= MAX_FILES_TOUCHED) {
            send({
              kind: 'tool_result',
              tool: tc.name,
              ok: false,
              summary: 'task touched too many files',
              error: `maxFilesPerTask=${MAX_FILES_TOUCHED} reached`,
            });
            send({ kind: 'done', done: true, error: 'max-files-per-task' });
            return { ok: false, error: 'max-files-per-task' };
          }
          touchedFiles.add(pathArg);
        }

        // Execute the tool.
        const result = await executeTool(tc.name, tc.raw, workspaceRoot, win, requestId, readFiles);
        // A real tool executed — the next no-tool turn earns fresh
        // corrective attempts.
        nudges = 0;

        send({
          kind: 'tool_result',
          tool: tc.name,
          ok: result.ok,
          summary: result.summary,
          error: result.error,
        });

        if (reqState.userAborted) {
          send({ kind: 'done', done: true, aborted: true });
          return { ok: true };
        }

        // Push assistant message (truncated to just before tool call) +
        // a user message containing the tool result, then continue.
        const assistantSoFar =
          assistantBuffer.slice(0, tc.endInOutput) +
          `\n<tool_result tool="${tc.name}">\n${result.modelText}\n</tool_result>\n`;
        convo.push({ role: 'assistant', content: assistantSoFar });
        convo.push({
          role: 'user',
          content:
            result.ok
              ? `Результат инструмента ${tc.name} применён. Продолжай: если задача решена — заверши ответ, иначе вызови следующий инструмент.`
              : `Инструмент ${tc.name} вернул ошибку: ${result.error}. Подумай, как исправить, и повтори или сообщи пользователю.`,
        });

        if (step === MAX_STEPS - 1) {
          send({ kind: 'text', chunk: '\n\n_(лимит шагов агента достигнут)_\n' });
        }
      }

      // Auto "what was done" worklog — only when the task actually changed
      // files and the caller didn't opt out.
      if (!finalError && touchedFiles.size > 0 && params.logWorklog !== false) {
        const userReq =
          [...messages].reverse().find((m) => m.role === 'user')?.content || 'Задача';
        try {
          brain.logWork({
            title: userReq.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Задача',
            files: [...touchedFiles],
            details: userReq.slice(0, 2000),
            projectRoot: workspaceRoot,
            sourceRef: requestId,
          });
        } catch {
          /* worklog must never break the agent */
        }
      }

      send({ kind: 'done', done: true, error: finalError });
      return { ok: !finalError, error: finalError };
    } catch (err: any) {
      if (err.name === 'AbortError' || reqState.userAborted) {
        send({ kind: 'done', done: true, aborted: true });
        return { ok: true };
      }
      send({ kind: 'done', done: true, error: err.message });
      return { ok: false, error: err.message };
    } finally {
      activeRequests.delete(requestId);
      if (ownsLock) lock.release?.();
    }
  },

  abort(requestId: string): boolean {
    return abortRequest(requestId);
  },
};

export const TOOL_PROTOCOL_PROMPT = `У тебя есть РУКИ — инструменты для работы с файлами проекта пользователя.

КОГДА вызывать инструменты:
- Не знаешь, где в проекте лежит нужный код? СНАЧАЛА используй search — это быстрее, чем перебирать файлы через list_dir/read_file.
- Прежде чем править файл — обязательно прочитай его (read_file), чтобы знать точное содержимое.
- НИКОГДА не выдавай полные перезаписанные файлы в ответе пользователю — используй edit_file для точечной замены.
- Если файл новый — используй create_file.

ФОРМАТ вызова: один инструмент за раз, ровно такой XML-блок (без markdown-обёртки):

<tool name="read_file">
<path>относительный/путь.tsx</path>
</tool>

После каждого вызова система вставит <tool_result>...</tool_result> с результатом. Дождись его и решай следующий шаг. Когда задача решена — просто напиши финальный ответ пользователю БЕЗ <tool> блоков.

ПРАВИЛА ДОСТОВЕРНОСТИ (анти-галлюцинации):
- НИКОГДА не выдумывай содержимое файлов, пути, имена функций или результаты команд. Если не читал — прочитай.
- Опирайся ТОЛЬКО на данные из <tool_result>. Если результат свёрнут или устарел — вызови инструмент заново.
- Если данных недостаточно для уверенного ответа — скажи это прямо вместо догадок.
- edit_file БЕЗ предварительного read_file в этой же задаче будет отклонён системой.

Доступные инструменты:

1) read_file — прочитать файл. Для больших файлов читай по частям: необязательные <offset> (номер первой строки, с 1) и <limit> (количество строк). Ответ содержит total_lines; если файл показан не полностью — продолжай с указанного offset, пока не увидишь всё нужное.
<tool name="read_file">
<path>src/foo.ts</path>
</tool>
<tool name="read_file">
<path>src/big-file.ts</path>
<offset>401</offset>
<limit>400</limit>
</tool>

2) search — найти код по проекту (регистронезависимый regex или подстрока). Возвращает строки вида path:line: текст. Используй ЭТО, чтобы находить функции/символы/места использования.
<tool name="search">
<query>function handleSubmit</query>
</tool>
(необязательный <path>src</path> ограничивает поиск папкой.)

3) list_dir — список содержимого папки (без path = корень проекта).
<tool name="list_dir">
<path>src/components</path>
</tool>

4) edit_file — ТОЧЕЧНАЯ замена. old_string должен встречаться в файле РОВНО ОДИН РАЗ (включая отступы и пробелы). Если фрагмент не уникален — расширь old_string соседними строками для уникальности. Только при явной необходимости поставь <replace_all>true</replace_all> для замены всех вхождений.
<tool name="edit_file">
<path>src/foo.ts</path>
<old_string>точный фрагмент со всеми пробелами
вторая строка</old_string>
<new_string>новый код
вторая строка</new_string>
</tool>

5) create_file — создать новый файл (или перезаписать существующий — но для существующих предпочитай edit_file).
<tool name="create_file">
<path>src/new.ts</path>
<content>export const x = 1;
</content>
</tool>

6) delete_file — удалить файл (используй с осторожностью, только когда пользователь явно попросил).
<tool name="delete_file">
<path>src/old.ts</path>
</tool>

7) read_recipe — read one of the bundled cdesign skill recipes (only useful when you are in CDESIGN mode). Names match files under references/recipes/ without the .md extension, e.g. lenis-gsap-sync, pinned-scrub, r3f-photo, split-reveal, scroll-film, liquid-glass, multi-layer-parallax, canvas-scrub, easing, etc.
<tool name="read_recipe">
<name>pinned-scrub</name>
</tool>

8) run_command — execute a shell command inside the user's workspace. Available only if the user has enabled "Allow terminal commands" in settings. By default each command also requires explicit user approval (a dialog appears in the chat). The shell is PowerShell on Windows and /bin/sh on Linux/macOS. Output is captured and returned (stdout + stderr + exit code). Use this for: running tests (npm test), installing deps (npm install), git operations (git status, git diff, git log), formatters/linters, etc. NEVER use it for destructive operations without explicit user instruction (rm -rf, format, shutdown — these are HARD-BLOCKED regardless of settings).
<tool name="run_command">
<command>npm test</command>
<cwd>packages/web</cwd>
<timeout_ms>120000</timeout_ms>
</tool>
- <cwd> is optional (defaults to workspace root). Must resolve INSIDE the workspace.
- <timeout_ms> is optional (defaults to the configured timeout, max 30 minutes).
- If the user has not enabled terminal commands, this tool returns an error explaining that. Don't keep retrying — tell the user to enable it in settings.

9) mcp_list_tools — список внешних MCP-инструментов, подключённых пользователем (файловые системы, базы данных, браузеры, API и т.д.). Вызови один раз, если задача может требовать внешних возможностей.
<tool name="mcp_list_tools">
</tool>

10) mcp_call — вызвать MCP-инструмент. <arguments> — JSON-объект по schema из mcp_list_tools.
<tool name="mcp_call">
<server>filesystem</server>
<tool>read_file</tool>
<arguments>{"path": "/tmp/data.json"}</arguments>
</tool>

ВАЖНО:
- Слова «сейчас прочитаю файл», «использую create_file» и т.п. БЕЗ XML-блока НИЧЕГО не делают: система исполняет ТОЛЬКО XML-блоки <tool ...>. Решил использовать инструмент — немедленно, в этом же ответе, выведи блок.
- НИКОГДА не пиши тег <tool_result> сам — его вставляет только система после реального вызова. Написать <tool_result> самому = выдумать результат.
- Только ОДИН <tool> блок за раз. После </tool> остановись и жди <tool_result>.
- В <old_string> копируй ТОЧНЫЙ текст из read_file, символ-в-символ, со всеми пробелами и переносами.
- Никаких "..." или "// rest of file" — это запрещено. Каждый edit_file меняет только то, что нужно поменять.
- После ВСЕХ нужных правок дай пользователю краткое резюме того, что сделал.
`;
