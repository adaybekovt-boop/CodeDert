import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getActiveWorkspaceRoot } from './workspace.js';
import { safeResolveInWorkspace } from './path-safety.js';

/**
 * /cdesign integration — see electron/resources/cdesign/SKILL.md.
 *
 * The skill bundle ships with the app under `electron/resources/cdesign/`.
 * In dev: relative to the source tree.
 * In production (electron-builder): resources are unpacked next to the asar
 * under `process.resourcesPath/cdesign/` (configured via build.extraResources).
 *
 * Exposed via IPC:
 *   - cdesign:get-system-prompt  → assembled system prompt (skill + core refs)
 *   - cdesign:list-recipes       → recipe filenames + 1-line descriptions
 *   - cdesign:read-recipe(name)  → raw recipe contents
 *   - cdesign:scaffold(targetDir)→ extracts cdesign-starter.zip into targetDir
 *
 * The renderer runs the workflow itself (so it can interleave with the chat
 * UI). We only expose the static knowledge surface + scaffolder here.
 */

const CORE_FILES = [
  'SKILL.md',
  'references/director-roll.md',
  'references/anti-slop.md',
  'references/content-system.md',
];

interface RecipeMeta {
  name: string;
  description: string;
}

let cachedSystemPrompt: string | null = null;
let cachedRecipes: RecipeMeta[] | null = null;

function resourcesDir(): string {
  // In production the resources folder lives next to the app under
  // process.resourcesPath. In dev electron-builder isn't involved, so we
  // resolve relative to the compiled main.js location (dist-electron/...).
  // The repo layout puts the resources under <repo>/electron/resources/.
  // Either path is acceptable — try the production path first, fall back to
  // walking up from __dirname.
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'cdesign-resources');
  }
  // dev / non-packaged: dist-electron/main.js → ../electron/resources
  // and tests / direct node invocations: cwd/electron/resources.
  const candidates = [
    path.join(process.cwd(), 'electron', 'resources'),
    path.join(__dirname, '..', '..', 'electron', 'resources'),
  ];
  for (const c of candidates) {
    try {
      if (fsSyncExists(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return candidates[0];
}

function fsSyncExists(p: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsSync = require('node:fs');
    return fsSync.existsSync(p);
  } catch {
    return false;
  }
}

function cdesignDir(): string {
  return path.join(resourcesDir(), 'cdesign');
}

function starterZipPath(): string {
  return path.join(resourcesDir(), 'cdesign-starter.zip');
}

async function readFileSafe(rel: string): Promise<string> {
  const full = path.join(cdesignDir(), rel);
  try {
    return await fs.readFile(full, 'utf-8');
  } catch (err: any) {
    return `[cdesign: missing ${rel} — ${err.message}]`;
  }
}

function firstLineSummary(content: string): string {
  // Try to find first non-frontmatter, non-empty heading or paragraph.
  const lines = content.split('\n');
  let inFrontmatter = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (i === 0 && line === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line === '---') inFrontmatter = false;
      continue;
    }
    if (!line) continue;
    if (line.startsWith('#')) {
      // Skill summary often lives in the line after the heading.
      const next = lines[i + 1]?.trim();
      if (next && !next.startsWith('#')) return next.slice(0, 140);
      return line.replace(/^#+\s*/, '').slice(0, 140);
    }
    return line.slice(0, 140);
  }
  return '(no description)';
}

export const cdesign = {
  /**
   * Build the system prompt for /cdesign. Cached on first call.
   * Includes SKILL.md + 3 core references (~43kB total).
   */
  async getSystemPrompt(): Promise<string> {
    if (cachedSystemPrompt) return cachedSystemPrompt;
    const parts: string[] = [
      '# CDESIGN MODE — Cinematic Landing Page Generator',
      '',
      'You are running the cdesign skill inside CodeDert IDE. The complete skill manual and core references follow. Read them and follow the workflow strictly.',
      '',
      '## Adaptations for CodeDert',
      '- You are NOT in a fresh terminal. You are inside a local IDE with a workspace and file tools.',
      '- DO NOT run `npx create-next-app`. Instead, if the user asks to scaffold a project, tell them to use the in-app "Scaffold cdesign-starter" button or the `/cdesign --scaffold <dir>` flag.',
      '- For recipes beyond the core 3 (director-roll, anti-slop, content-system) you have an extra tool: `read_recipe`. Call it like the other file tools:',
      '  ```',
      '  <tool name="read_recipe"><name>pinned-scrub</name></tool>',
      '  ```',
      '  to retrieve a specific recipe from the bundled `references/recipes/`. Use this ON DEMAND — do not preload all recipes.',
      '- When generating files, use the standard `create_file` / `edit_file` tools and target paths INSIDE the user\'s workspace.',
      '- If no workspace is open, do not write files. Respond with a plan and the 4 Director\'s Roll vibes for the user to choose from.',
      '',
      '## Director\'s Roll output format',
      'After reading the references, ALWAYS output ONE block of the form:',
      '```',
      'Director\'s Roll: <VIBE_NAME> selected because <one-line reason>.',
      '```',
      'before any code. Then a brief plan (5-8 lines).',
      '',
    ];

    for (const rel of CORE_FILES) {
      const content = await readFileSafe(rel);
      parts.push(`\n# === ${rel} ===\n`);
      parts.push(content);
    }

    cachedSystemPrompt = parts.join('\n');
    return cachedSystemPrompt;
  },

  /**
   * Enumerate all recipes under references/recipes/ with a 1-line summary.
   */
  async listRecipes(): Promise<RecipeMeta[]> {
    if (cachedRecipes) return cachedRecipes;
    const recipesDir = path.join(cdesignDir(), 'references', 'recipes');
    try {
      const entries = await fs.readdir(recipesDir, { withFileTypes: true });
      const out: RecipeMeta[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const name = entry.name.replace(/\.md$/, '');
        const content = await fs.readFile(path.join(recipesDir, entry.name), 'utf-8');
        out.push({ name, description: firstLineSummary(content) });
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      cachedRecipes = out;
      return out;
    } catch (err: any) {
      return [];
    }
  },

  /**
   * Read a recipe by name (without `.md`). Returns null when missing.
   * Path is constrained to references/recipes/ to prevent traversal.
   */
  async readRecipe(name: string): Promise<{ ok: boolean; content?: string; error?: string }> {
    const cleaned = String(name || '').trim().replace(/\.md$/i, '');
    if (!/^[a-z0-9][a-z0-9_-]{0,60}$/i.test(cleaned)) {
      return { ok: false, error: 'invalid recipe name' };
    }
    const full = path.join(cdesignDir(), 'references', 'recipes', `${cleaned}.md`);
    const root = path.resolve(cdesignDir());
    const resolved = path.resolve(full);
    if (!resolved.startsWith(root)) return { ok: false, error: 'path escapes resources' };
    try {
      const content = await fs.readFile(resolved, 'utf-8');
      return { ok: true, content };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  },

  /**
   * Extract the bundled cdesign-starter.zip into `targetDir`.
   * Uses PowerShell's Expand-Archive on Windows; falls back to system unzip.
   * Returns ok=true and the resolved target path on success.
   */
  async scaffoldStarter(
    targetDir: string
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    const zip = starterZipPath();
    try {
      await fs.access(zip);
    } catch {
      return { ok: false, error: `starter zip not bundled: ${zip}` };
    }
    const targetCheck = safeResolveInWorkspace(targetDir, getActiveWorkspaceRoot());
    if (!targetCheck.ok) return { ok: false, error: targetCheck.error };
    const target = targetCheck.absolute!;
    try {
      await fs.mkdir(target, { recursive: true });
    } catch (err: any) {
      return { ok: false, error: `cannot create ${target}: ${err.message}` };
    }

    const ok = await runExtractor(zip, target);
    if (!ok.ok) return ok;
    return { ok: true, path: target };
  },

  /** Path utilities exposed for diagnostics. */
  paths() {
    return {
      resources: resourcesDir(),
      cdesign: cdesignDir(),
      starterZip: starterZipPath(),
    };
  },
};

async function runExtractor(
  zipPath: string,
  targetDir: string
): Promise<{ ok: boolean; error?: string }> {
  // Prefer PowerShell on Windows for zero-dependency extraction.
  if (process.platform === 'win32') {
    return runChild('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -Path "${zipPath}" -DestinationPath "${targetDir}" -Force`,
    ]);
  }
  // Linux / macOS: assume `unzip` is available.
  return runChild('unzip', ['-o', zipPath, '-d', targetDir]);
}

function runChild(cmd: string, args: string[]): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    p.on('error', (err) => resolve({ ok: false, error: err.message }));
    p.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: stderr || `${cmd} exited with ${code}` });
    });
  });
}
