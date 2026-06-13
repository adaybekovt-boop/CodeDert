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

export interface ToolCall {
  raw: string;
  name: string;
  startInOutput: number;
  endInOutput: number;
}

/**
 * Scan the streamed buffer for the next *complete* tool block.
 * Returns null if no complete block yet (might still be streaming).
 */
export function findCompletedToolCall(buffer: string): ToolCall | null {
  const openRe = /<tool\s+name=["']([a-z_]+)["']\s*>/i;
  const open = buffer.match(openRe);
  if (!open) return null;
  const openIdx = open.index!;
  const closeTag = '</tool>';
  const closeIdx = buffer.indexOf(closeTag, openIdx);
  if (closeIdx === -1) return null;
  const endIdx = closeIdx + closeTag.length;
  return {
    raw: buffer.slice(openIdx, endIdx),
    name: open[1].toLowerCase(),
    startInOutput: openIdx,
    endInOutput: endIdx,
  };
}

const TOOL_NAMES =
  'read_file|list_dir|search|edit_file|create_file|delete_file|run_command|read_recipe|mcp_list_tools|mcp_call';

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
  const re = /<tool(?=[\s>])/g;
  re.lastIndex = from;
  const m = re.exec(buffer);
  if (m) return m.index;
  // Otherwise hold back the last ~6 chars in case `<tool` is still arriving.
  return Math.max(from, buffer.length - 6);
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
