/**
 * Secret detection for the Brain auto-capture layer.
 *
 * Pure module — no electron/node imports beyond TS. Imported by both the live
 * brain service and unit tests, so its rules are guarded by test coverage.
 *
 * Strategy:
 *   1. Targeted regex for known credential formats (Anthropic, OpenAI, GitHub,
 *      Slack, AWS, Stripe, JWT, SSH private key headers).
 *   2. Generic high-entropy heuristic: long base64/hex strings that look
 *      random, plus KEY=value lines where KEY contains a sensitive keyword.
 *   3. File-path mentions of .env / id_rsa / *.pem treated as sensitive.
 *
 * `containsSecret(text)` returns true on first match — the caller is expected
 * to reject the candidate memory entirely, not redact it (redaction is
 * brittle).
 */

const KEY_PATTERNS: RegExp[] = [
  // Anthropic
  /\bsk-ant-[A-Za-z0-9_-]{30,}/,
  // OpenAI
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/,
  // GitHub
  /\bghp_[A-Za-z0-9]{30,}/,
  /\bgho_[A-Za-z0-9]{30,}/,
  /\bghr_[A-Za-z0-9]{30,}/,
  /\bghu_[A-Za-z0-9]{30,}/,
  /\bghs_[A-Za-z0-9]{30,}/,
  // Slack
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  // AWS
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bASIA[0-9A-Z]{16}\b/,
  // Stripe
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/,
  // Google / GCP API keys
  /\bAIza[0-9A-Za-z_-]{30,}/,
  // JWTs (header.payload.signature)
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  // Private key blocks (SSH/PEM)
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY/,
];

const SENSITIVE_KEY_WORDS = [
  'password',
  'passwd',
  'secret',
  'token',
  'api[_-]?key',
  'auth[_-]?key',
  'private[_-]?key',
  'access[_-]?token',
  'refresh[_-]?token',
  'client[_-]?secret',
];

const KEY_VALUE_REGEX = new RegExp(
  String.raw`(?:^|\b)(?:[A-Z][A-Z0-9_]{2,}_(?:` +
    SENSITIVE_KEY_WORDS.join('|') +
    String.raw`)|(?:` +
    SENSITIVE_KEY_WORDS.join('|') +
    String.raw`))\s*[:=]\s*['"]?([^\s'"\n]{6,})['"]?`,
  'i'
);

const FILE_HINTS = /(?:^|[\\\/\s])(?:\.env(?:\.[a-z0-9-]+)?|id_rsa|id_ed25519|\S+\.pem)\b/i;

// High-entropy fallback: a base64/hex blob ≥ 32 chars that contains both
// alphabetic case mixes or digits is suspicious. We deliberately set this
// somewhat strict so common UUIDs, sha hashes in commit messages, and prose
// don't false-positive. Empirically tuned with the unit tests.
const HIGH_ENTROPY_REGEX = /\b(?=[A-Za-z0-9+\/_=-]*[A-Za-z])(?=[A-Za-z0-9+\/_=-]*[0-9])[A-Za-z0-9+\/_=-]{40,}\b/;

export interface SecretMatch {
  hit: boolean;
  reason?: string;
  /** Up to 40 chars of the matched snippet — for diagnostic display only. */
  preview?: string;
}

export function detectSecret(text: string): SecretMatch {
  if (!text) return { hit: false };

  for (const re of KEY_PATTERNS) {
    const m = text.match(re);
    if (m) return { hit: true, reason: 'known credential format', preview: redact(m[0]) };
  }
  const kv = text.match(KEY_VALUE_REGEX);
  if (kv) return { hit: true, reason: 'sensitive key=value', preview: redact(kv[0]) };
  if (FILE_HINTS.test(text)) {
    return { hit: true, reason: 'mentions secret file (.env / id_rsa / *.pem)' };
  }
  const he = text.match(HIGH_ENTROPY_REGEX);
  if (he) {
    // Tighten: must NOT look like a checksum (only hex) — those are usually
    // safe in commit/code discussions. Reject if there's at least one
    // non-hex letter character, otherwise treat as benign hash.
    if (/[g-zG-Z+\/_=-]/.test(he[0])) {
      return { hit: true, reason: 'high-entropy blob', preview: redact(he[0]) };
    }
  }
  return { hit: false };
}

export function containsSecret(text: string): boolean {
  return detectSecret(text).hit;
}

function redact(snippet: string): string {
  if (snippet.length <= 8) return '***';
  return snippet.slice(0, 6) + '…' + '*'.repeat(Math.min(4, snippet.length - 6));
}
