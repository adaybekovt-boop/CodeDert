import path from 'node:path';

export interface PathCheck {
  ok: boolean;
  error?: string;
  absolute?: string;
  relative?: string;
}

/**
 * Resolve a path against the workspace root. Returns `ok=false` if the resolved
 * absolute path escapes the workspace.
 *
 * Uses `path.relative` so prefix collisions like `/foo/bar` vs `/foo/bar-other`
 * are correctly rejected.
 */
export function safeResolveInWorkspace(rawPath: string, workspaceRoot: string | null): PathCheck {
  if (!workspaceRoot) return { ok: false, error: 'no workspace open' };
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return { ok: false, error: 'empty path' };
  }
  const cleaned = rawPath.trim().replace(/^["']|["']$/g, '');
  const rootResolved = path.resolve(workspaceRoot);
  const candidate = path.isAbsolute(cleaned)
    ? path.resolve(cleaned)
    : path.resolve(rootResolved, cleaned);
  const rel = path.relative(rootResolved, candidate);
  if (rel === '' || rel === '.') {
    // Path equals workspace root itself — allowed (e.g. list_dir on root).
    return { ok: true, absolute: candidate, relative: '' };
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: `path escapes workspace: ${rawPath}` };
  }
  return { ok: true, absolute: candidate, relative: rel.replace(/\\/g, '/') };
}

/**
 * Allow only web/email schemes through `shell.openExternal`. Blocks `file:`,
 * custom protocol handlers, and anything else that can launch a local program.
 * URLs reaching openExternal come from AI-rendered markdown and untrusted file
 * content, so an unvalidated scheme is a code-execution vector on Windows.
 */
export function isSafeExternalUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:';
}

/**
 * Match a path against a list of simple glob patterns. Supports:
 *   - `**` (any directories)
 *   - `*`  (any segment chars, no slash)
 *   - exact segment names
 */
export function matchesAnyGlob(relPath: string, patterns: string[]): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  for (const pattern of patterns) {
    const regex = globToRegExp(pattern);
    if (regex.test(normalized)) return true;
  }
  return false;
}

function globToRegExp(pattern: string): RegExp {
  // Escape regex meta except for glob operators we replace below.
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** — any chars including /
        re += '.*';
        i += 2;
        // Skip a trailing slash after ** so `**/foo` matches `foo` at root.
        if (pattern[i] === '/') i += 1;
        continue;
      }
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    if ('.+^$()|{}[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
    i += 1;
  }
  return new RegExp('^' + re + '$', 'i');
}

/**
 * True iff `relPath` is protected by any of the patterns.
 * Used as the gate around .env, *.pem, secrets.*, etc.
 */
export function isProtectedPath(relPath: string, protectedGlobs: string[]): boolean {
  return matchesAnyGlob(relPath, protectedGlobs);
}
