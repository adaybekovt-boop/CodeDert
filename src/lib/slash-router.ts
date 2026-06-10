/**
 * Central slash-command registry + parser.
 *
 * Adding a command in one place keeps:
 *   - autocomplete (ChatPanel),
 *   - /help body,
 *   - handler dispatch (ChatPanel.handleSend),
 * in sync.
 *
 * Handlers themselves live in ChatPanel (so they can use `useStore`, `useChat`,
 * the runners, etc.) but the registry below is the source of truth for which
 * commands exist and how they're described.
 */

export type SlashKind =
  | 'help'
  | 'clear'
  | 'stop'
  | 'settings'
  | 'models'
  | 'ask'
  | 'edit'
  | 'fix'
  | 'review'
  | 'explain'
  | 'test'
  | 'commit'
  | 'index'
  | 'plan'
  | 'multyplan'
  | 'multyplanApprove'
  | 'multyplanReject'
  | 'ultrathink'
  | 'design'
  | 'cdesign'
  | 'image'
  | 'model'
  | 'brain';

export interface SlashCommand {
  name: string;
  kind: SlashKind;
  description: string;
  usage: string;
  icon: string;
  /** When true, command needs an open workspace folder. */
  needsWorkspace?: boolean;
  /** When true, command needs a selected model. */
  needsModel?: boolean;
  /** Optional aliases that resolve to the same kind. */
  aliases?: string[];
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', kind: 'help', description: 'Show all commands', usage: '/help', icon: '?' },
  { name: '/clear', kind: 'clear', description: 'Clear chat history', usage: '/clear', icon: '🗑' },
  { name: '/stop', kind: 'stop', description: 'Cancel current AI task', usage: '/stop', icon: '⏹' },
  { name: '/settings', kind: 'settings', description: 'Open settings panel', usage: '/settings', icon: '⚙' },
  { name: '/models', kind: 'models', description: 'List available local models', usage: '/models', icon: '📦' },
  { name: '/model', kind: 'model', description: 'Switch active model', usage: '/model <name>', icon: '🤖' },
  { name: '/index', kind: 'index', description: 'Re-scan workspace file tree', usage: '/index', icon: '📁', needsWorkspace: true },
  { name: '/ask', kind: 'ask', description: 'Ask about the project (no edits)', usage: '/ask <question>', icon: '❔', needsModel: true },
  { name: '/edit', kind: 'edit', description: 'Edit selected/active file', usage: '/edit <instruction>', icon: '✎', needsModel: true, needsWorkspace: true },
  { name: '/fix', kind: 'fix', description: 'Find and fix a bug', usage: '/fix <symptom>', icon: '🔧', needsModel: true, needsWorkspace: true },
  { name: '/review', kind: 'review', description: 'Review code for issues', usage: '/review [target]', icon: '🔍', needsModel: true, needsWorkspace: true },
  { name: '/explain', kind: 'explain', description: 'Explain selected file/function/error', usage: '/explain [target]', icon: '💡', needsModel: true },
  { name: '/test', kind: 'test', description: 'Suggest tests for current file', usage: '/test [target]', icon: '🧪', needsModel: true, needsWorkspace: true },
  { name: '/commit', kind: 'commit', description: 'Suggest a commit message', usage: '/commit', icon: '📝', needsModel: true, needsWorkspace: true },
  { name: '/plan', kind: 'plan', description: 'Opus Plan — Claude designs, local executes', usage: '/plan <task>', icon: '🧠', needsWorkspace: true },
  { name: '/multyplan', kind: 'multyplan', description: 'DeepSeek plan → Gemma critique → approval → Qwen execute', usage: '/multyplan <task>', icon: '🧩', needsWorkspace: true },
  { name: '/multyplan-approve', kind: 'multyplanApprove', description: 'Approve the latest pending /multyplan plan', usage: '/multyplan-approve', icon: 'OK' },
  { name: '/multyplan-reject', kind: 'multyplanReject', description: 'Reject the latest pending /multyplan plan', usage: '/multyplan-reject', icon: 'NO' },
  { name: '/ultrathink', kind: 'ultrathink', description: 'Deep repo analysis only (no edits)', usage: '/ultrathink[:deepseek|:gemma] <task>', icon: 'UT', needsWorkspace: true },
  { name: '/design', kind: 'design', description: 'UX/UI critique mode', usage: '/design', icon: '🎨' },
  { name: '/cdesign', kind: 'cdesign', description: 'Cinematic landing page generator (Next 15 + Motion + GSAP + R3F)', usage: '/cdesign <brief> [--scaffold <dir>] [--shotlist] [--research] [--recipes] [--paths]', icon: '🎬' },
  { name: '/image', kind: 'image', description: 'Generate image via Stable Diffusion', usage: '/image <prompt> [--save-as path]', icon: '🖼' },
  { name: '/brain', kind: 'brain', description: 'Open Brain knowledge graph (subcommands: add, search, related, inject, review, forget)', usage: '/brain [add|search|related|inject|review|forget] <args>', icon: '🧠' },
];

export interface ParsedSlash {
  /** The matched command name (canonical, with leading `/`, lowercase). */
  command: string;
  /** Sub-tag after `:`, e.g. for `/ultrathink:gemma`. */
  variant?: string;
  /** Resolved kind, for switch dispatch. */
  kind: SlashKind;
  /** Everything after the command. */
  args: string;
  /** Raw matched text including the slash. */
  raw: string;
}

export function parseSlashCommand(text: string): ParsedSlash | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed.startsWith('/')) return null;
  const match = trimmed.match(/^(\/[a-z][a-z0-9_-]*)(?::([a-z0-9_-]+))?\s*([\s\S]*)$/i);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const variant = match[2]?.toLowerCase();
  const args = match[3] || '';
  const cmd =
    SLASH_COMMANDS.find((c) => c.name === name) ||
    SLASH_COMMANDS.find((c) => (c.aliases || []).includes(name));
  if (!cmd) {
    return { command: name, variant, kind: 'ask', args, raw: trimmed };
  }
  return { command: cmd.name, variant, kind: cmd.kind, args, raw: trimmed };
}

export function isKnownSlash(text: string): boolean {
  const p = parseSlashCommand(text);
  if (!p) return false;
  return SLASH_COMMANDS.some((c) => c.name === p.command);
}

export function getSuggestions(input: string): SlashCommand[] {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed.startsWith('/')) return [];
  return SLASH_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(trimmed)).slice(0, 12);
}

export function formatHelpMarkdown(): string {
  return SLASH_COMMANDS.map(
    (c) => `${c.icon} **${c.name}** — ${c.description}\n  \`${c.usage}\``
  ).join('\n\n');
}
