/**
 * Pure helpers for the XML tool protocol used by the agent loop.
 *
 * No electron / node imports on purpose — everything here is unit-testable
 * in isolation (see tests/agent-protocol.test.ts). The stateful loop itself
 * lives in agent.ts.
 */

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Read content of a single <field>...</field> inside a tool block. */
export function readField(block: string, name: string): string | null {
  // Greedy across newlines, capture between <name> and </name>
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i');
  const m = block.match(re);
  if (!m) return null;
  return unescapeXml(m[1]);
}

/**
 * Read the first of several accepted field names. Weak models rarely match the
 * exact field name from the prompt — they write <old> for <old_string>, <file>
 * for <path>, <query> vs <pattern>, etc. Trying a synonym list turns a hard
 * "missing field" failure into a successful tool call.
 */
export function readFieldAny(block: string, names: readonly string[]): string | null {
  for (const n of names) {
    const v = readField(block, n);
    if (v != null) return v;
  }
  return null;
}

/**
 * For a name-as-tag block like `<read_file>config.json</read_file>`, return the
 * trimmed inner text — but ONLY when it has no nested `<field>` tags, so a
 * structured multi-field block is never mistaken for a bare value. Lets
 * single-argument tools work when the model puts the value straight in the body
 * instead of a `<path>`/`<query>`/`<command>` field.
 */
export function bareBodyArg(block: string): string | null {
  const m = block.match(/^<([a-z_]+)\s*>([\s\S]*)<\/\1>\s*$/i);
  if (!m) return null;
  const inner = m[2];
  if (/<[a-z_]+\s*>/i.test(inner)) return null; // has child tags → structured
  const v = unescapeXml(inner).trim();
  return v || null;
}

/** Field-name synonyms accepted per logical argument (case-insensitive). */
export const FIELD_ALIASES = {
  path: ['path', 'file', 'file_path', 'filepath', 'filename', 'target_file'],
  old_string: ['old_string', 'oldstring', 'old_str', 'old', 'search', 'find', 'before'],
  new_string: ['new_string', 'newstring', 'new_str', 'new', 'replacement', 'replace', 'after'],
  content: ['content', 'text', 'body', 'code', 'data', 'file_text'],
  query: ['query', 'pattern', 'q', 'text', 'search'],
  command: ['command', 'cmd', 'shell', 'run'],
  question: ['question', 'prompt', 'q', 'ask', 'message', 'text'],
} as const;

export const TOOL_NAMES =
  'read_file|list_dir|search|edit_file|create_file|delete_file|run_command|read_recipe|mcp_list_tools|mcp_call|ask';

export interface ToolCall {
  raw: string;
  name: string;
  startInOutput: number;
  endInOutput: number;
}

/**
 * Scan the streamed buffer for the next *complete* tool block. Two formats are
 * accepted (earliest complete one wins):
 *
 *   A. canonical:  <tool name="read_file"> … </tool>
 *   B. name-as-tag: <read_file> … </read_file>
 *
 * Format B is what a large share of weak local models default to, so accepting
 * it directly removes a whole class of "model did nothing" turns. Format A is
 * lenient on quoting (`name=read_file`, `name='read_file'`, spaces around `=`).
 * Returns null if no complete block yet (might still be streaming).
 */
export function findCompletedToolCall(buffer: string): ToolCall | null {
  const candidates: ToolCall[] = [];

  // Format A — <tool name="...">...</tool>
  const aOpen = buffer.match(/<tool\s+name\s*=\s*["']?([a-z_]+)["']?\s*>/i);
  if (aOpen) {
    const openIdx = aOpen.index!;
    const closeIdx = buffer.indexOf('</tool>', openIdx);
    if (closeIdx !== -1) {
      const endIdx = closeIdx + '</tool>'.length;
      candidates.push({
        raw: buffer.slice(openIdx, endIdx),
        name: aOpen[1].toLowerCase(),
        startInOutput: openIdx,
        endInOutput: endIdx,
      });
    }
  }

  // Format B — <read_file>...</read_file> (tool name used as the tag itself).
  const bOpen = buffer.match(new RegExp(`<(${TOOL_NAMES})\\s*>`, 'i'));
  if (bOpen) {
    const name = bOpen[1].toLowerCase();
    const openIdx = bOpen.index!;
    const closeIdx = buffer.toLowerCase().indexOf(`</${name}>`, openIdx);
    if (closeIdx !== -1) {
      const endIdx = closeIdx + name.length + 3; // </ + name + >
      candidates.push({
        raw: buffer.slice(openIdx, endIdx),
        name,
        startInOutput: openIdx,
        endInOutput: endIdx,
      });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.startInOutput - b.startInOutput);
  return candidates[0];
}

/** Intent verb followed (within ~80 chars) by a concrete tool name:
 *  "использую create_file", "сейчас вызову read_file", "let me run search". */
const INTENT_NEAR_TOOL_RE = new RegExp(
  `(использу\\w+|вызов\\w+|вызыва\\w+|вызову|запущу|применю|выполню|сейчас|сначала|далее|затем|теперь|let me|i(?:'|’)?ll|will|using|use)[\\s\\S]{0,80}?\\b(${TOOL_NAMES})\\b`,
  'i'
);

/**
 * True when the model *described* a tool call in prose (or fabricated a
 * <tool_result>) but never emitted an actual <tool name="..."> block.
 * Such a turn did nothing — the loop must issue a corrective step instead
 * of silently ending.
 */
export function looksLikeToolIntentWithoutCall(text: string): boolean {
  if (!text || findCompletedToolCall(text)) return false;
  const t = text.trim();
  // Only the system may emit <tool_result> — a model writing it is inventing
  // results without doing the work.
  if (/<tool_result\b/i.test(t)) return true;
  if (INTENT_NEAR_TOOL_RE.test(t)) return true;
  return (
    /(вызов\w*|вызыва\w*|call\w*)\s+(инструмент|tool)/i.test(t) ||
    /(сейчас|сначала|начинаю|начну|first step|первый шаг)[\s\S]{0,200}(прочитаю|посмотрю|read_file|list_dir|search|инструмент|tool|структур|entry|main)/i.test(t) ||
    /(посмотрю|изучу|проверю|найду|прочитаю|создам|заменю|исправлю)[\s\S]{0,200}(структур|файл|entry|main|lib|папк|строк)/i.test(t)
  );
}

/**
 * Where can we safely flush text to the UI?
 * Up to the last point that cannot possibly be the start of a `<tool ...>` tag.
 * Only genuine tool opens (`<tool ` / `<tool>`) are hidden — a `<tool_result`
 * echoed by a confused model must NOT freeze the visible stream forever.
 */
export function findSafeTextBoundary(buffer: string, from: number): number {
  // Hide both call formats: `<tool ...>` and the name-as-tag `<read_file>`.
  const re = new RegExp(`<tool(?=[\\s>])|<(?:${TOOL_NAMES})(?=[\\s>])`, 'gi');
  re.lastIndex = from;
  const m = re.exec(buffer);
  if (m) return m.index;
  // Otherwise hold back the last ~16 chars in case an opening tag is still
  // arriving (the longest tool name, `mcp_list_tools`, plus `<` and `>`).
  return Math.max(from, buffer.length - 16);
}

/**
 * Token economy: collapse tool_result bodies in all but the last N assistant
 * messages. Old file dumps are stale anyway — the model is told to re-read
 * if it needs them again. This keeps long agent sessions cheap on API
 * providers and prevents local-model context overflow.
 */
export function collapseOldToolResults(convo: AgentMessage[], keepLastN = 2): void {
  const assistantIdxs: number[] = [];
  for (let i = 0; i < convo.length; i++) {
    if (convo[i].role === 'assistant') assistantIdxs.push(i);
  }
  const cutoff = assistantIdxs.length - keepLastN;
  for (let k = 0; k < cutoff; k++) {
    const i = assistantIdxs[k];
    convo[i] = {
      ...convo[i],
      content: convo[i].content.replace(
        /<tool_result\b([^>]*)>[\s\S]*?<\/tool_result>/g,
        (full, attrs) =>
          full.length > 1500
            ? `<tool_result${attrs}>[свёрнуто для экономии токенов — данные устарели; при необходимости вызови инструмент снова]</tool_result>`
            : full
      ),
    };
  }
}
