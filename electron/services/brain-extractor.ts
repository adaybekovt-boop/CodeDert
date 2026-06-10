/**
 * Heuristic memory extractor for the Brain auto-capture loop.
 *
 * No AI call — pure text matching. Recognises ten kinds of recurring
 * statements in chat exchanges and proposes typed Brain memory candidates.
 *
 * Each candidate has a confidence score:
 *   - 0.85 for explicit markers (TODO:, IMPORTANT:, "decided to use",
 *     "we'll go with"),
 *   - 0.65 for soft phrasing ("we should", "I prefer", "let's"),
 *   - 0.40 for inferred patterns,
 * which the caller compares against `brain.minConfidence`.
 *
 * The extractor returns plain objects; the calling service applies secret
 * filtering, dedup, and persists to disk.
 */

import { containsSecret } from './brain-secrets.js';

export type BrainNodeType =
  | 'idea'
  | 'project'
  | 'architecture'
  | 'bug'
  | 'workflow'
  | 'decision'
  | 'warning'
  | 'concept'
  | 'memory'
  | 'task'
  | 'prompt'
  | 'code_pattern'
  | 'worklog';

export const BRAIN_NODE_TYPES: BrainNodeType[] = [
  'idea',
  'project',
  'architecture',
  'bug',
  'workflow',
  'decision',
  'warning',
  'concept',
  'memory',
  'task',
  'prompt',
  'code_pattern',
  'worklog',
];

export interface ExtractedCandidate {
  type: BrainNodeType;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  confidence: number;
  importance: number;
  /** Which speaker / message produced the candidate. */
  origin: 'user' | 'assistant';
}

export interface ExtractInput {
  user: string;
  assistant: string;
  /** Optional file paths recently touched (kept as linked metadata). */
  contextFiles?: string[];
}

interface Rule {
  type: BrainNodeType;
  /** Match against a single line; capture group 1 (if any) becomes the title body. */
  pattern: RegExp;
  confidence: number;
  importance: number;
  tagsExtra?: string[];
}

const RULES: Rule[] = [
  // ── Explicit markers — high confidence ────────────────────
  { type: 'task', pattern: /^\s*TODO\s*[:\-]\s*(.+)$/im, confidence: 0.9, importance: 0.7, tagsExtra: ['todo'] },
  { type: 'bug', pattern: /^\s*FIXME\s*[:\-]\s*(.+)$/im, confidence: 0.9, importance: 0.75, tagsExtra: ['fixme'] },
  { type: 'warning', pattern: /^\s*(?:IMPORTANT|WARNING|CAUTION)\s*[:\-]\s*(.+)$/im, confidence: 0.9, importance: 0.85 },
  { type: 'memory', pattern: /^\s*(?:NOTE|REMEMBER)\s*[:\-]\s*(.+)$/im, confidence: 0.85, importance: 0.6 },

  // ── Decisions ─────────────────────────────────────────────
  { type: 'decision', pattern: /\b(?:decided to|we(?:'ll|\s+will) (?:use|go with|stick with)|let'?s use|going with)\s+(.{6,120})/i, confidence: 0.8, importance: 0.75 },
  { type: 'decision', pattern: /\b(?:choice|pick|chosen):\s+(.+)$/im, confidence: 0.75, importance: 0.7 },

  // ── Architecture statements ───────────────────────────────
  { type: 'architecture', pattern: /\b([A-Z][\w.-]+)\s+(?:uses|depends on|is built on|is powered by)\s+([A-Za-z][\w.-]+)/, confidence: 0.7, importance: 0.7, tagsExtra: ['architecture'] },
  { type: 'architecture', pattern: /\bthe (?:[A-Z]\w+\s+)?(?:app|backend|frontend|service|module|system|store|graph|api|server|client) (?:uses|relies on|depends on)\s+(.{4,80})/i, confidence: 0.65, importance: 0.65, tagsExtra: ['architecture'] },

  // ── Bugs ──────────────────────────────────────────────────
  { type: 'bug', pattern: /\b(?:bug|crash|broken|fails?|breaks?|regression|error)\s*[:\-]\s*(.+)$/im, confidence: 0.75, importance: 0.7 },
  { type: 'bug', pattern: /\bthis (?:causes|breaks|leaks|hangs|crashes|freezes)\s+(.{4,100})/i, confidence: 0.7, importance: 0.7 },

  // ── Warnings ──────────────────────────────────────────────
  { type: 'warning', pattern: /\b(?:never|don'?t|do not|avoid|must not)\s+(.{4,120})/i, confidence: 0.7, importance: 0.75 },

  // ── Preferences / workflow rules ──────────────────────────
  { type: 'workflow', pattern: /\b(?:always|prefer to|prefer)\s+(.{4,120})/i, confidence: 0.65, importance: 0.6, tagsExtra: ['preference'] },
  { type: 'workflow', pattern: /\bI (?:like|hate|want|prefer) (.{4,120})/i, confidence: 0.6, importance: 0.55, tagsExtra: ['preference'] },

  // ── Ideas / future work ───────────────────────────────────
  { type: 'idea', pattern: /\b(?:we should|could|let'?s|maybe|future:|next step:)\s+(.{6,140})/i, confidence: 0.6, importance: 0.55 },
  { type: 'idea', pattern: /\bidea\s*[:\-]\s*(.+)$/im, confidence: 0.8, importance: 0.65 },
];

/**
 * Extract candidates from a single user/assistant exchange.
 * - Both speakers are scanned.
 * - Code blocks are extracted separately as code_pattern candidates (only if
 *   they are sizeable and contain identifiers).
 * - Secret-containing lines are dropped.
 */
export function extractCandidates(input: ExtractInput): ExtractedCandidate[] {
  const out: ExtractedCandidate[] = [];
  const seen = new Set<string>();

  for (const [origin, raw] of [
    ['user', input.user] as const,
    ['assistant', input.assistant] as const,
  ]) {
    if (!raw) continue;
    if (containsSecret(raw)) continue;

    // Scan code blocks first, then strip them so they don't pollute prose rules.
    const codeBlocks: { lang: string; body: string }[] = [];
    const stripped = raw.replace(/```([a-z0-9_+-]*)\n([\s\S]*?)```/gi, (_m, lang, body) => {
      codeBlocks.push({ lang: String(lang || '').toLowerCase(), body: String(body) });
      return '\n';
    });

    for (const cb of codeBlocks) {
      if (cb.body.length < 60 || cb.body.length > 4000) continue;
      if (containsSecret(cb.body)) continue;
      if (!/[a-zA-Z_$][a-zA-Z0-9_$]{2,}/.test(cb.body)) continue;
      const titleLine = cb.body.split('\n').find((l) => l.trim().length > 0) || '';
      const title = `${cb.lang || 'code'}: ${titleLine.slice(0, 80).trim()}`;
      if (alreadyProposed(seen, title)) continue;
      seen.add(normTitle(title));
      out.push({
        type: 'code_pattern',
        title,
        summary: `Reusable ${cb.lang || 'code'} pattern from ${origin} message.`,
        content: cb.body,
        tags: ['code', cb.lang || 'code'].filter(Boolean),
        confidence: 0.65,
        importance: 0.55,
        origin,
      });
    }

    // Process line-by-line for the rule list.
    const lines = stripped.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length < 6) continue;
      if (containsSecret(trimmed)) continue;

      for (const rule of RULES) {
        const m = trimmed.match(rule.pattern);
        if (!m) continue;
        const captured = (m[1] || m[0]).trim();
        if (captured.length < 4) continue;
        const cleanTitle = clip(captured, 100);
        if (alreadyProposed(seen, cleanTitle)) continue;
        seen.add(normTitle(cleanTitle));
        out.push({
          type: rule.type,
          title: cleanTitle,
          summary: clip(trimmed, 280),
          content: trimmed,
          tags: collectTags(trimmed, rule),
          confidence: rule.confidence,
          importance: rule.importance,
          origin,
        });
        break; // one rule per line is enough
      }
    }
  }

  return out;
}

function alreadyProposed(seen: Set<string>, title: string): boolean {
  return seen.has(normTitle(title));
}

export function normTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}

function collectTags(line: string, rule: Rule): string[] {
  const tags = new Set<string>([rule.type]);
  for (const extra of rule.tagsExtra || []) tags.add(extra);
  // Pull #hashtag-style tags directly from the line.
  const re = /#([a-zA-Z][a-zA-Z0-9_-]{1,30})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) tags.add(m[1].toLowerCase());
  return Array.from(tags);
}

/**
 * Title-level similarity used both by the extractor (for self-dedup against
 * a list of recent suggestions) and the live service (against existing nodes).
 * Returns Jaccard over normalized title tokens.
 */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(normTitle(a).split(' ').filter((t) => t.length >= 3));
  const tb = new Set(normTitle(b).split(' ').filter((t) => t.length >= 3));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}
