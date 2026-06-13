import { useEffect, useRef } from 'react';
import { useStore } from './useStore';
import { genId, relativePath } from '../lib/utils';
import {
  CODE_SYSTEM_PROMPT,
  DESIGN_SYSTEM_PROMPT,
  CDESIGN_SYSTEM_PROMPT,
} from '../lib/prompts';
import { parseSlashCommand } from '../lib/slash-router';
import { chatRegistry } from '../lib/cdesign-send';
import { useBrainStore } from '../lib/brain-store';
import type { ChatMessage, FileNode, OpenFile } from '../types';

export interface SendOptions {
  /** Force chat-only (no file-tool agent loop) — used by /ask and /explain. */
  forceChat?: boolean;
  /** Prepend an additional system instruction. */
  systemSuffix?: string;
  /** Override system prompt entirely. */
  systemOverride?: string;
  /** Append extra context after the user text. */
  contextSuffix?: string;
  /** Hide the user message in the chat (used by `/commit` which only wants the assistant output). */
  hideUserMessage?: boolean;
  /** Echo this as the user-facing message body instead of `text`. */
  echoText?: string;
}

function buildTreeLines(node: FileNode, root: string | null, depth = 0, lines: string[] = []): string[] {
  if (lines.length >= 180) return lines;
  const rel = relativePath(node.path, root);
  const label = depth === 0 ? rel || node.name : `${'  '.repeat(depth)}${node.isDir ? '▸' : '-'} ${node.name}`;
  lines.push(label);
  if (node.isDir && node.children && depth < 5) {
    for (const child of node.children) {
      buildTreeLines(child, root, depth + 1, lines);
      if (lines.length >= 180) break;
    }
  }
  return lines;
}

function fileBlock(file: OpenFile, workspaceRoot: string | null, title: string, maxBytes: number): string {
  const rel = relativePath(file.path, workspaceRoot);
  const content =
    file.content.length > maxBytes
      ? `${file.content.slice(0, maxBytes)}\n\n/* ...file truncated for context... */`
      : file.content;
  return `\n\n[${title}: ${rel}]\n\`\`\`${file.language}\n${content}\n\`\`\``;
}

/** Which XML field the agent protocol uses for each tool's primary argument. */
const TOOL_ARG_FIELD: Record<string, string> = {
  search: 'query',
  run_command: 'command',
  read_recipe: 'name',
  ask: 'question',
};

/**
 * Rebuild an assistant message for model-facing history.
 *
 * In agent mode the raw <tool> XML is hidden from the visible chat content
 * (tool calls render as structured ToolEvent blocks instead). If history were
 * sent as-is, every past assistant turn would show the model an example of
 * "doing" tool work in plain prose — after a few turns the model imitates
 * that and stops emitting real <tool> blocks. Reconstructing a compact XML
 * trace keeps the protocol visible as a few-shot anchor.
 */
function assistantHistoryContent(m: ChatMessage): string {
  const events = m.toolEvents || [];
  if (events.length === 0) return m.content;
  const trace = events
    .map((ev) => {
      const field = TOOL_ARG_FIELD[ev.tool] || 'path';
      const arg = ev.target ? `\n<${field}>${ev.target}</${field}>` : '';
      const body = ev.status === 'error' ? `ERROR: ${ev.output || 'failed'}` : ev.output || 'OK';
      return `<tool name="${ev.tool}">${arg}\n</tool>\n<tool_result tool="${ev.tool}">\n${body}\n</tool_result>`;
    })
    .join('\n');
  return `${trace}\n\n${m.content}`;
}

async function refreshOpenFileIfAny(path: string) {
  const state = useStore.getState();
  const open = state.openFiles.find((f) => f.path === path);
  if (!open) return;
  const res = await window.api.workspace.readFile(path);
  if (res.ok && typeof res.content === 'string') {
    useStore.setState((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.path === path ? { ...f, content: res.content!, dirty: false } : f
      ),
    }));
  }
}

/**
 * Send the last user/assistant pair to the Brain auto-capture extractor.
 * Fires once per streamed completion, never blocks the UI, and is silently
 * skipped if Brain is disabled (the main process short-circuits there).
 */
function fireAutoCapture(assistantMsgId: string) {
  const state = useStore.getState();
  const idx = state.messages.findIndex((m) => m.id === assistantMsgId);
  if (idx === -1) return;
  const assistantMsg = state.messages[idx];
  if (!assistantMsg || assistantMsg.role !== 'assistant') return;
  const assistantText = (assistantMsg.content || '').trim();
  if (assistantText.length < 20) return;
  // Most recent user message above this assistant.
  let userText = '';
  for (let i = idx - 1; i >= 0; i--) {
    if (state.messages[i].role === 'user') {
      userText = state.messages[i].content;
      break;
    }
  }
  if (!userText && !assistantText) return;
  window.api.brain
    .proposeFromChat({
      user: userText,
      assistant: assistantText,
      contextFiles: state.openFiles.map((f) => f.path),
      sourceRef: assistantMsgId,
    })
    .catch(() => {});
}

export function useChat() {
  const activeRequestId = useRef<string | null>(null);
  const activeMode = useRef<'ollama' | 'anthropic' | 'agent' | 'providers' | null>(null);

  // Expose mutators so external senders (cdesign-runner, etc.) can drive the
  // same streaming pipeline this hook owns.
  chatRegistry.setActive = (id, mode) => {
    activeRequestId.current = id;
    activeMode.current = mode;
  };
  chatRegistry.getActive = () => ({
    requestId: activeRequestId.current,
    mode: activeMode.current,
  });

  useEffect(() => {
    const offOllama = window.api.ollama.onChunk((data) => {
      if (data.requestId !== activeRequestId.current) return;
      const state = useStore.getState();
      const lastMsg = state.messages[state.messages.length - 1];
      if (!lastMsg || lastMsg.role !== 'assistant') return;
      if (data.chunk) state.appendToMessage(lastMsg.id, data.chunk);
      if (data.done) {
        state.finishMessage(lastMsg.id, (data as any).error);
        state.setStreaming(false);
        activeRequestId.current = null;
        activeMode.current = null;
        if (!(data as any).error) fireAutoCapture(lastMsg.id);
      }
    });

    const offAnthropic = window.api.anthropic.onChunk((data) => {
      if (data.requestId !== activeRequestId.current) return;
      const state = useStore.getState();
      const lastMsg = state.messages[state.messages.length - 1];
      if (!lastMsg || lastMsg.role !== 'assistant') return;
      if (data.chunk) {
        state.appendToMessage(lastMsg.id, data.chunk, data.type === 'thinking' ? 'thinking' : 'content');
      }
      if (data.done) {
        state.finishMessage(lastMsg.id, (data as any).error);
        state.setStreaming(false);
        activeRequestId.current = null;
        activeMode.current = null;
        if (!(data as any).error) fireAutoCapture(lastMsg.id);
      }
    });

    const offProviders = window.api.providers.onChunk((data) => {
      if (data.requestId !== activeRequestId.current) return;
      const state = useStore.getState();
      const lastMsg = state.messages[state.messages.length - 1];
      if (!lastMsg || lastMsg.role !== 'assistant') return;
      if (data.chunk) {
        state.appendToMessage(lastMsg.id, data.chunk, data.type === 'thinking' ? 'thinking' : 'content');
      }
      if (data.done) {
        state.finishMessage(lastMsg.id, (data as any).error);
        state.setStreaming(false);
        activeRequestId.current = null;
        activeMode.current = null;
        if (!(data as any).error) fireAutoCapture(lastMsg.id);
      }
    });

    const offAgent = window.api.agent.onEvent(async (data) => {
      if (data.requestId !== activeRequestId.current) return;
      const state = useStore.getState();
      const lastMsg = state.messages[state.messages.length - 1];

      // 'done' must ALWAYS clear streaming state, even if the message list is
      // in an unexpected shape — a swallowed done leaves the UI spinning forever.
      if (data.kind === 'done') {
        const msg =
          lastMsg && lastMsg.role === 'assistant'
            ? lastMsg
            : [...state.messages].reverse().find((m) => m.role === 'assistant');
        if (msg) {
          state.finishMessage(msg.id, data.error);
          if (!data.error) fireAutoCapture(msg.id);
        }
        state.setStreaming(false);
        activeRequestId.current = null;
        activeMode.current = null;
        return;
      }

      if (!lastMsg || lastMsg.role !== 'assistant') return;

      if (data.kind === 'text' && data.chunk) {
        state.appendToMessage(lastMsg.id, data.chunk);
        return;
      }

      if (data.kind === 'tool_call') {
        const argsPath = data.args?.path ?? data.args?.command ?? data.args?.query ?? data.args?.question;
        state.addToolEvent(lastMsg.id, {
          id: genId(),
          tool: data.tool || 'tool',
          target: argsPath ? String(argsPath) : undefined,
          status: 'running',
          anchor: lastMsg.content.length,
        });
        return;
      }

      if (data.kind === 'tool_result') {
        // Close the most recent still-running event for this tool.
        const events = lastMsg.toolEvents || [];
        const open = [...events].reverse().find(
          (ev) => ev.status === 'running' && (ev.tool === data.tool || !data.tool)
        );
        if (open) {
          state.updateToolEvent(lastMsg.id, open.id, {
            status: data.ok ? 'done' : 'error',
            output: data.ok ? data.summary : data.error || data.summary,
          });
        }

        if (data.ok && (data.tool === 'edit_file' || data.tool === 'create_file' || data.tool === 'delete_file')) {
          await useStore.getState().refreshFileTree();
          const openPaths = useStore.getState().openFiles.map((f) => f.path);
          for (const p of openPaths) await refreshOpenFileIfAny(p);
          // Regenerate project map in the background — AI sees newly created
          // files (with their first lines) on the next turn.
          useStore.getState().refreshProjectMap().catch(() => {});
        }
        return;
      }
    });

    return () => {
      offOllama();
      offAnthropic();
      offProviders();
      offAgent();
    };
  }, []);

  async function send(text: string, opts: SendOptions = {}) {
    const state = useStore.getState();
    const { selectedModel, openFiles, activeFilePath, workspaceRoot, fileTree, projectMap, chatMode } = state;
    const brainStore = useBrainStore.getState();

    if (!selectedModel) {
      alert('Select a model first');
      return;
    }
    if (!text.trim()) return;

    const slash = parseSlashCommand(text);
    const isCloud = selectedModel.provider !== 'ollama';
    const useAgent = !opts.forceChat && chatMode === 'code' && !!workspaceRoot;
    // Cap context block. Default 16k per file; halved when many files open.
    const perFileBudget = openFiles.length > 4 ? 8000 : 16000;

    let contextBlock = '';
    if (workspaceRoot) {
      contextBlock += `\n\n[Project]\nRoot: ${workspaceRoot}`;
      if (projectMap) {
        contextBlock += `\n\n[Project Map — автоматически сгенерированная карта проекта]\n${projectMap}\n[/Project Map]`;
      } else if (fileTree) {
        contextBlock += `\n\n[File tree]\n${buildTreeLines(fileTree, workspaceRoot).join('\n')}`;
      }
    } else {
      contextBlock += '\n\n[Project]\nNo project folder is open.';
    }

    if (isCloud && useAgent) {
      // Token economy for API models in agent mode: do NOT inline file
      // contents — the model has read_file (with offset/limit) and search.
      // Передаём только пути, модель сама читает то, что нужно.
      if (activeFilePath) {
        contextBlock += `\n\n[Active file]\n${relativePath(activeFilePath, workspaceRoot)}`;
      }
      const otherPaths = openFiles.filter((f) => f.path !== activeFilePath).slice(0, 8);
      if (otherPaths.length > 0) {
        contextBlock += `\n\n[Other open files]\n${otherPaths
          .map((f) => relativePath(f.path, workspaceRoot))
          .join('\n')}`;
      }
      contextBlock +=
        '\n\n[Note] Содержимое файлов не приложено. Используй read_file/search, чтобы посмотреть нужные файлы целиком.';
    } else {
      if (activeFilePath) {
        const af = openFiles.find((f) => f.path === activeFilePath);
        if (af) contextBlock += fileBlock(af, workspaceRoot, 'Active file', perFileBudget);
      }

      const extraOpenFiles = openFiles.filter((f) => f.path !== activeFilePath).slice(0, 4);
      if (extraOpenFiles.length > 0) {
        contextBlock += `\n\n[Other open files]\n${extraOpenFiles
          .map((f) => relativePath(f.path, workspaceRoot))
          .join('\n')}`;
        for (const file of extraOpenFiles) {
          contextBlock += fileBlock(file, workspaceRoot, 'Open file', perFileBudget);
        }
      }
    }

    if (opts.contextSuffix) contextBlock += `\n\n${opts.contextSuffix}`;

    // ── Brain retrieval ───────────────────────────────────
    // Pull pinned + top-scoring Brain memories and inject them as a context
    // block. The retrieval policy lives in the main process (it reads
    // brain.injectRelevantNotes / maxInjectedNodes / minConfidence).
    try {
      const appSettings = await window.api.appSettings.get();
      const maxBrainNodes = Math.max(0, Math.min(50, Number(appSettings?.brain?.maxInjectedNodes ?? 5)));
      const retrieved = await window.api.brain.retrieveForPrompt(text, undefined);
      const pinnedIds = brainStore.pinnedIds;
      const pinnedNodes = pinnedIds
        .map((id) => brainStore.nodes.find((n) => n.id === id))
        .filter(Boolean) as { id: string; title: string; type: string; summary: string }[];
      // Merge pinned in front, drop dupes.
      const seen = new Set<string>();
      const merged: { node: any; via: 'pinned' | 'match' | 'neighbor'; score: number }[] = [];
      for (const n of pinnedNodes) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        merged.push({ node: n, via: 'pinned', score: Infinity });
      }
      for (const r of retrieved) {
        if (seen.has(r.node.id)) continue;
        seen.add(r.node.id);
        merged.push({ node: r.node, via: r.via, score: r.score });
      }
      if (merged.length > maxBrainNodes) merged.length = maxBrainNodes;
      if (merged.length > 0) {
        const block = merged
          .map((r) => `- (${r.node.type}) ${r.node.title}${r.node.summary ? ` — ${r.node.summary}` : ''}`)
          .join('\n');
        contextBlock += `\n\n[Brain memory — relevant past notes]\n${block}\n[End Brain memory]`;
      }
      brainStore.setLastInjection(text, merged as any);
    } catch (err) {
      console.warn('brain retrieve failed', err);
    }

    if (!opts.hideUserMessage) {
      const userMsg: ChatMessage = {
        id: genId(),
        role: 'user',
        content: opts.echoText ?? text,
        timestamp: Date.now(),
      };
      state.addMessage(userMsg);
    }

    const history = state.messages
      .filter((m) => m.role !== 'system' && !m.error)
      .map((m) => ({
        role: m.role,
        content: m.role === 'assistant' ? assistantHistoryContent(m) : m.content,
      }));
    history.push({ role: 'user', content: text + contextBlock });

    let systemPrompt = opts.systemOverride ?? CODE_SYSTEM_PROMPT;
    if (!opts.systemOverride && chatMode === 'design') systemPrompt = DESIGN_SYSTEM_PROMPT;
    if (!opts.systemOverride && (chatMode === 'cdesign' || slash?.kind === 'cdesign'))
      systemPrompt = CDESIGN_SYSTEM_PROMPT;
    if (opts.systemSuffix) systemPrompt = `${systemPrompt}\n\n${opts.systemSuffix}`;

    const assistantMsg: ChatMessage = {
      id: genId(),
      role: 'assistant',
      content: '',
      thinking: '',
      model: selectedModel.displayName,
      timestamp: Date.now(),
      streaming: true,
    };
    state.addMessage(assistantMsg);
    state.setStreaming(true);

    const requestId = genId();
    activeRequestId.current = requestId;

    if (useAgent) {
      // Tool-using agent loop — now for EVERY provider (local and API).
      activeMode.current = 'agent';
      await window.api.agent.chat({
        model: selectedModel.id,
        messages: history as any,
        system: systemPrompt,
        workspaceRoot,
        requestId,
        provider: selectedModel.provider,
      });
    } else if (selectedModel.provider === 'anthropic') {
      activeMode.current = 'anthropic';
      await window.api.anthropic.chat({
        model: selectedModel.id,
        messages: history,
        system: systemPrompt,
        requestId,
        adaptiveThinking: true,
        effort: 'high',
      });
    } else if (isCloud) {
      activeMode.current = 'providers';
      await window.api.providers.chat({
        providerId: selectedModel.provider,
        model: selectedModel.id,
        messages: history,
        system: systemPrompt,
        requestId,
      });
    } else {
      activeMode.current = 'ollama';
      await window.api.ollama.chat({
        model: selectedModel.id,
        messages: history,
        system: systemPrompt,
        requestId,
      });
    }
  }

  function abort() {
    if (activeRequestId.current) {
      const id = activeRequestId.current;
      if (activeMode.current === 'agent') {
        window.api.agent.abort(id);
      } else if (activeMode.current === 'providers') {
        window.api.providers.abort(id);
      } else {
        window.api.ollama.abort(id);
      }
      activeRequestId.current = null;
      activeMode.current = null;
    }
    // Tell main to cancel whichever AI task is holding the global lock.
    window.api.ai.stop().catch(() => {});
    useStore.getState().setStreaming(false);
  }

  return { send, abort };
}
