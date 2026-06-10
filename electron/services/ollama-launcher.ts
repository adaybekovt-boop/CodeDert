import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ollama } from './ollama.js';
import { appSettings } from './settings.js';

/**
 * Try to ensure Ollama is running before the renderer needs it.
 *
 * Strategy:
 *   1. Probe `ollama.health()`. If OK, return immediately.
 *   2. Otherwise spawn the Ollama binary as a detached background process.
 *      - Windows: explicit install paths, then PATH lookup.
 *      - macOS:   `open -a Ollama` (Ollama.app spawns the server tray).
 *      - Linux:   `ollama serve` via PATH.
 *   3. Poll health for up to `timeoutMs`. Return status.
 *
 * The launcher never crashes the main process — every failure is reported
 * via the return value so the renderer can decide how to display it.
 */

export interface LaunchResult {
  ok: boolean;
  /** Was Ollama already running before we touched anything? */
  alreadyRunning?: boolean;
  /** Did we actually attempt to spawn it? */
  spawned?: boolean;
  /** How long we waited for health, ms. */
  waitedMs?: number;
  /** Resolved binary path / command used when spawning. */
  command?: string;
  error?: string;
}

const HEALTH_POLL_MS = 500;
const DEFAULT_TIMEOUT_MS = 12_000;

let inFlight: Promise<LaunchResult> | null = null;

export const ollamaLauncher = {
  /**
   * Idempotent: parallel callers receive the same in-flight promise.
   */
  ensureRunning(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<LaunchResult> {
    if (inFlight) return inFlight;
    inFlight = run(timeoutMs).finally(() => {
      inFlight = null;
    });
    return inFlight;
  },
};

async function run(timeoutMs: number): Promise<LaunchResult> {
  // Fast path — already up.
  const first = await ollama.health();
  if (first.ok) {
    return { ok: true, alreadyRunning: true, waitedMs: 0 };
  }

  const cmd = resolveOllamaCommand();
  if (!cmd) {
    return {
      ok: false,
      error:
        'Ollama executable not found. Install from https://ollama.com/download and re-open the app.',
    };
  }

  try {
    spawnDetached(cmd);
  } catch (err: any) {
    return { ok: false, error: `spawn failed: ${err.message || err}`, command: cmd.display };
  }

  // Poll until Ollama answers /api/version or we hit timeoutMs.
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(HEALTH_POLL_MS);
    const h = await ollama.health();
    if (h.ok) {
      return {
        ok: true,
        spawned: true,
        waitedMs: Date.now() - start,
        command: cmd.display,
      };
    }
  }
  return {
    ok: false,
    spawned: true,
    waitedMs: Date.now() - start,
    command: cmd.display,
    error: `Ollama did not become healthy within ${timeoutMs}ms after launch.`,
  };
}

interface ResolvedCommand {
  cmd: string;
  args: string[];
  display: string;
}

function resolveOllamaCommand(): ResolvedCommand | null {
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama app.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Ollama', 'ollama.exe'),
      path.join('C:\\Program Files', 'Ollama', 'ollama.exe'),
    ];
    for (const c of candidates) {
      if (c && fs.existsSync(c)) {
        return {
          cmd: c,
          args: c.endsWith('ollama.exe') ? ['serve'] : [],
          display: c,
        };
      }
    }
    // Fall back to PATH — `ollama` is added by the official installer.
    return { cmd: 'ollama', args: ['serve'], display: 'ollama (PATH)' };
  }

  if (process.platform === 'darwin') {
    // `open -a Ollama` launches the menu-bar app which hosts the server.
    // If the user installed just the CLI via Homebrew, fall back to that.
    const appPath = '/Applications/Ollama.app';
    if (fs.existsSync(appPath)) {
      return { cmd: 'open', args: ['-a', 'Ollama'], display: appPath };
    }
    return { cmd: 'ollama', args: ['serve'], display: 'ollama (PATH)' };
  }

  // Linux / others — assume `ollama serve` on PATH.
  return { cmd: 'ollama', args: ['serve'], display: 'ollama (PATH)' };
}

function spawnDetached({ cmd, args }: ResolvedCommand): void {
  const child = spawn(cmd, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    // Use the user's home as cwd to avoid keeping our install dir busy.
    cwd: os.homedir(),
  });
  // Allow the parent to exit independently of the child.
  child.unref();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Helper for `main.ts`: respects the `provider.ollama.autoStart` setting and
 * silently no-ops when the user has turned auto-start off.
 */
export async function maybeAutoStartOllama(): Promise<LaunchResult | { ok: false; error: string }> {
  const settings = appSettings.get();
  if (settings.provider.ollama.autoStart === false) {
    return { ok: false, error: 'autoStart disabled' };
  }
  return ollamaLauncher.ensureRunning();
}
