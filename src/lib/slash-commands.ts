/**
 * Legacy entry. Forwards to the new slash-router module so old imports keep
 * working while we transition.
 */
export {
  SLASH_COMMANDS,
  parseSlashCommand,
  getSuggestions,
  formatHelpMarkdown,
  isKnownSlash,
} from './slash-router';
export type { SlashCommand, SlashKind, ParsedSlash } from './slash-router';
