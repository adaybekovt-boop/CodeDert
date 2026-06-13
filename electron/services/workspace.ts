import { dialog, BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { appSettings } from './settings.js';
import { isProtectedPath, safeResolveInWorkspace } from './path-safety.js';
import { findClosestFragment } from './edit-fuzzy.js';

export interface FileNode {
  id: string;
  name: string;
  path: string;
  isDir: boolean;
  children?: FileNode[];
}

const MAX_DEPTH = 8;
const MAX_FILES_PER_DIR = 1000;

// Limits for content search (search tool). Keep bounded so a huge repo can't
// stall the agent loop.
const SEARCH_MAX_FILES = 4000;
const SEARCH_MAX_MATCHES = 200;
const SEARCH_MAX_FILE_BYTES = 2_000_000;
const SEARCH_SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.bmp', '.svg',
  '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib',
  '.bin', '.dat', '.wasm', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp4', '.mov', '.mp3', '.wav', '.ogg', '.webm', '.lock', '.map',
]);

function ignoredSet(): Set<string> {
  return new Set(appSettings.get().workspace.ignoredFolders);
}

function showHidden(): boolean {
  return appSettings.get().workspace.includeHidden;
}

function maxFileBytes(): number {
  return appSettings.get().workspace.maxFileBytes;
}

let activeWorkspaceRoot: string | null = null;

/**
 * The single source of truth for which folder is currently "the workspace".
 * Set by `openFolder`; read by IPC-level path guards so the renderer cannot
 * pass arbitrary absolute paths into read/write/edit/delete handlers.
 */
export function getActiveWorkspaceRoot(): string | null {
  return activeWorkspaceRoot;
}

export function setActiveWorkspaceRoot(root: string | null): void {
  activeWorkspaceRoot = root ? path.resolve(root) : null;
}

function checkPath(
  rawPath: string,
  opts: { allowProtected?: boolean } = {}
): { ok: boolean; absolute?: string; relative?: string; error?: string } {
  const root = getActiveWorkspaceRoot();
  const r = safeResolveInWorkspace(rawPath, root);
  if (!r.ok) return { ok: false, error: r.error };
  const settings = appSettings.get();
  const rel = r.relative || '';
  if (!opts.allowProtected && rel && isProtectedPath(rel, settings.agent.protectedGlobs)) {
    if (!settings.agent.allowEnvEdits) {
      return { ok: false, error: `protected path: ${rel}` };
    }
  }
  return { ok: true, absolute: r.absolute!, relative: rel };
}

export const workspace = {
  async openFolder(win: BrowserWindow): Promise<{ root: string; tree: FileNode } | null> {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select project folder',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const root = result.filePaths[0];
    setActiveWorkspaceRoot(root);
    const tree = await this.listFiles(root);
    return { root, tree };
  },

  async listFiles(root: string, depth = 0): Promise<FileNode> {
    const stat = await fs.stat(root);
    const name = path.basename(root) || root;

    if (!stat.isDirectory()) {
      return { id: root, name, path: root, isDir: false };
    }

    const node: FileNode = {
      id: root,
      name,
      path: root,
      isDir: true,
      children: [],
    };

    if (depth >= MAX_DEPTH) return node;

    const ignored = ignoredSet();
    const allowHidden = showHidden();

    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      let count = 0;
      const dirChildren: FileNode[] = [];
      const fileChildren: FileNode[] = [];

      // Two-pass: collect names first, then recurse with concurrency-1 (the
      // existing serial behavior). Future improvement: use scanConcurrency.
      for (const entry of entries) {
        if (count >= MAX_FILES_PER_DIR) break;
        if (
          entry.name.startsWith('.') &&
          !allowHidden &&
          entry.name !== '.env' &&
          entry.name !== '.env.local'
        ) {
          continue;
        }
        if (ignored.has(entry.name)) continue;
        const childPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
          dirChildren.push(await this.listFiles(childPath, depth + 1));
        } else {
          fileChildren.push({
            id: childPath,
            name: entry.name,
            path: childPath,
            isDir: false,
          });
        }
        count++;
      }
      dirChildren.sort((a, b) => a.name.localeCompare(b.name));
      fileChildren.sort((a, b) => a.name.localeCompare(b.name));
      node.children = [...dirChildren, ...fileChildren];
    } catch (err) {
      console.error('listFiles error:', err);
    }

    return node;
  },

  async readFile(filePath: string): Promise<{ ok: boolean; content?: string; error?: string }> {
    const check = checkPath(filePath, { allowProtected: true });
    if (!check.ok) return { ok: false, error: check.error };
    try {
      const stat = await fs.stat(check.absolute!);
      const cap = maxFileBytes();
      if (stat.size > cap) {
        return { ok: false, error: `File too large (>${Math.round(cap / 1024 / 1024)}MB)` };
      }
      const content = await fs.readFile(check.absolute!, 'utf-8');
      return { ok: true, content };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  },

  async writeFile(filePath: string, content: string): Promise<{ ok: boolean; error?: string }> {
    const check = checkPath(filePath);
    if (!check.ok) return { ok: false, error: check.error };
    try {
      await fs.writeFile(check.absolute!, content, 'utf-8');
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  },

  async createFile(
    filePath: string,
    content: string
  ): Promise<{ ok: boolean; error?: string }> {
    const check = checkPath(filePath);
    if (!check.ok) return { ok: false, error: check.error };
    try {
      await fs.mkdir(path.dirname(check.absolute!), { recursive: true });
      await fs.writeFile(check.absolute!, content, 'utf-8');
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  },

  /**
   * Surgical search-and-replace edit on a file.
   * - Replaces oldString with newString exactly once unless replaceAll=true.
   * - Fails if oldString is not unique (when replaceAll=false) or not found.
   */
  async applyEdit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll = false
  ): Promise<{
    ok: boolean;
    error?: string;
    replacements?: number;
    diffPreview?: string;
  }> {
    const check = checkPath(filePath);
    if (!check.ok) return { ok: false, error: check.error };

    try {
      const content = await fs.readFile(check.absolute!, 'utf-8');
      if (oldString === newString) {
        return { ok: false, error: 'old_string and new_string are identical' };
      }
      if (oldString.length === 0) {
        return { ok: false, error: 'old_string must not be empty (use create_file)' };
      }

      let idx = 0;
      let count = 0;
      while (true) {
        const found = content.indexOf(oldString, idx);
        if (found === -1) break;
        count++;
        idx = found + oldString.length;
      }

      if (count === 0) {
        const close = findClosestFragment(content, oldString);
        if (close) {
          return {
            ok: false,
            error:
              `old_string not found — most likely a whitespace/indentation mismatch. ` +
              `The closest matching fragment is at lines ${close.startLine}-${close.endLine}. ` +
              `Copy it EXACTLY as <old_string> (byte-for-byte, including leading spaces) and retry:\n` +
              `===== exact fragment =====\n${close.fragment}\n===== end fragment =====`,
          };
        }
        return {
          ok: false,
          error:
            'old_string not found in file. Read the file first (read_file) and copy the exact fragment including whitespace.',
        };
      }
      if (count > 1 && !replaceAll) {
        return {
          ok: false,
          error: `old_string occurs ${count} times. Expand it with surrounding context, or pass replace_all=true.`,
        };
      }

      const next = replaceAll
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString);

      // Safety: respect maxEditBytes for the new file size.
      const maxEdit = appSettings.get().agent.maxEditBytes;
      if (Buffer.byteLength(next, 'utf-8') > maxEdit) {
        return { ok: false, error: `edit result exceeds maxEditBytes (${maxEdit})` };
      }

      await fs.writeFile(check.absolute!, next, 'utf-8');

      const preview = `- ${oldString.slice(0, 200)}${oldString.length > 200 ? '…' : ''}\n+ ${newString.slice(0, 200)}${newString.length > 200 ? '…' : ''}`;
      return { ok: true, replacements: replaceAll ? count : 1, diffPreview: preview };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  },

  /**
   * List one level of a directory (used by agent tool).
   */
  async listDirectory(dirPath: string): Promise<{
    ok: boolean;
    error?: string;
    entries?: { name: string; isDir: boolean }[];
  }> {
    const check = checkPath(dirPath, { allowProtected: true });
    if (!check.ok) return { ok: false, error: check.error };
    try {
      const ignored = ignoredSet();
      const allowHidden = showHidden();
      const entries = await fs.readdir(check.absolute!, { withFileTypes: true });
      const out = entries
        .filter((e) => !ignored.has(e.name))
        .filter(
          (e) =>
            !(e.name.startsWith('.') && !allowHidden && e.name !== '.env' && e.name !== '.env.local')
        )
        .map((e) => ({ name: e.name, isDir: e.isDirectory() }));
      out.sort((a, b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return a.name.localeCompare(b.name);
      });
      return { ok: true, entries: out };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  },

  async deleteFile(filePath: string): Promise<{ ok: boolean; error?: string }> {
    const check = checkPath(filePath);
    if (!check.ok) return { ok: false, error: check.error };
    try {
      await fs.rm(check.absolute!, { force: true });
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  },

  /**
   * Content search across the workspace (the agent's `search` tool).
   * `query` is treated as a case-insensitive regex; if it isn't a valid
   * regex it falls back to a literal substring match. Results are bounded.
   */
  async search(
    query: string,
    opts: { path?: string } = {}
  ): Promise<{
    ok: boolean;
    error?: string;
    matches?: { path: string; line: number; text: string }[];
    filesScanned?: number;
    truncated?: boolean;
  }> {
    const root = getActiveWorkspaceRoot();
    if (!root) return { ok: false, error: 'no workspace open' };
    // ReDoS guard: the pattern comes from model output. Cap its length and
    // never run it over unbounded lines (see slice below).
    const q = (query || '').trim().slice(0, 256);
    if (!q) return { ok: false, error: 'empty query' };

    let re: RegExp;
    try {
      re = new RegExp(q, 'i');
    } catch {
      re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    let base = root;
    if (opts.path && opts.path.trim()) {
      const c = checkPath(opts.path, { allowProtected: true });
      if (!c.ok) return { ok: false, error: c.error };
      base = c.absolute!;
    }

    const ignored = ignoredSet();
    const allowHidden = showHidden();
    const matches: { path: string; line: number; text: string }[] = [];
    let filesScanned = 0;
    let truncated = false;

    const stack: { dir: string; depth: number }[] = [{ dir: base, depth: 0 }];
    while (stack.length > 0) {
      const { dir, depth } = stack.pop()!;
      if (depth > MAX_DEPTH) continue;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (truncated) break;
        if (ignored.has(e.name)) continue;
        if (e.name.startsWith('.') && !allowHidden && e.name !== '.env' && e.name !== '.env.local') {
          continue;
        }
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          stack.push({ dir: full, depth: depth + 1 });
          continue;
        }
        if (SEARCH_SKIP_EXT.has(path.extname(e.name).toLowerCase())) continue;
        if (filesScanned >= SEARCH_MAX_FILES) {
          truncated = true;
          break;
        }
        let stat;
        try {
          stat = await fs.stat(full);
        } catch {
          continue;
        }
        if (stat.size > SEARCH_MAX_FILE_BYTES) continue;
        filesScanned++;
        let content: string;
        try {
          content = await fs.readFile(full, 'utf-8');
        } catch {
          continue;
        }
        if (content.indexOf('\u0000') !== -1) continue; // binary
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          // Bound regex input per line — catastrophic backtracking guard.
          if (lines[i].length > 2000) lines[i] = lines[i].slice(0, 2000);
          if (re.test(lines[i])) {
            const rel = path.relative(root, full).replace(/\\/g, '/');
            matches.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
            if (matches.length >= SEARCH_MAX_MATCHES) {
              truncated = true;
              break;
            }
          }
        }
      }
      if (truncated) break;
    }

    return { ok: true, matches, filesScanned, truncated };
  },

  /**
   * Resolve a path coming from the agent. Re-exported for backwards
   * compatibility with the existing agent loop.
   */
  resolveAgentPath(
    rawPath: string,
    workspaceRoot: string | null
  ): { ok: boolean; error?: string; absolute?: string; relative?: string } {
    const r = safeResolveInWorkspace(rawPath, workspaceRoot);
    if (!r.ok) return r;
    const settings = appSettings.get();
    if (
      !settings.agent.allowEnvEdits &&
      r.relative &&
      isProtectedPath(r.relative, settings.agent.protectedGlobs)
    ) {
      return { ok: false, error: `protected path: ${r.relative}` };
    }
    return r;
  },
};
