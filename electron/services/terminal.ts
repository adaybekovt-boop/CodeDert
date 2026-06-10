import type { BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { appSettings } from './settings.js';
import { getActiveWorkspaceRoot } from './workspace.js';
import { safeResolveInWorkspace } from './path-safety.js';

/**
 * Terminal execution service.
 *
 * Design goals:
 *   - **opt-in**: requires `agent.allowTerminal=true` in settings. Off by default.
 *   - **scoped**: cwd must resolve inside the active workspace.
 *   - **per-command approval**: when `agent.requireApprovalForCommands=true`,
 *     each run emits `terminal:approval-request` to the renderer and waits
 *     for an explicit response on `terminal:approval-response`.
 *   - **hard denylist**: a small set of patterns always refuse, regardless
 *     of settings (rm -rf /, format c:, mkfs, dd if=, fork-bomb, shutdown,
 *     reboot, etc.). The user cannot disable this.
 *   - **bounded output + timeout**: stdout/stderr capped at
 *     `agent.terminalMaxOutputBytes`; the process is killed after
 *     `agent.terminalTimeoutMs`.
 *   - **abort**: every run registers an AbortController under requestId so
 *     /stop and the AI mutex's cancel hook can kill it.
 *
 * Wire protocol (renderer ↔ main):
 *   main → renderer  channel `terminal:approval-request`
 *     payload: { requestId, command, cwd, timeoutMs }
 *   renderer → main  channel `terminal:approval-response`
 *     payload: { requestId, approved: boolean, reason?: string }
 *
 * The renderer hooks these via `window.api.terminal.onApprovalRequest` and
 * `window.api.terminal.respond`.
 */

const HARD_DENY: RegExp[] = [
  // Recursive deletion of root-ish paths.
  /\brm\s+-rf?\s+\/(?:\s|$)/i,
  /\brm\s+-rf?\s+~(?:\s|$)/i,
  /\brm\s+-rf?\s+\*(?:\s|$)/i,
  /\brm\s+-rf?\s+\.(?:\s|$)/i,
  // Windows drive wipes.
  /\bformat\s+[a-z]:/i,
  /\bdel\s+\/[sf]\b.*\\\*/i,
  // Disk-level overwrite.
  /\bdd\s+if=.*of=\/dev\//i,
  /\bmkfs(\.|\b)/i,
  // Powering off / restart.
  /\b(shutdown|halt|reboot|poweroff)\b/i,
  /\bSystem\.(?:Shutdown|Restart)\b/i,
  // Classic fork bomb.
  /:\s*\(\s*\)\s*\{\s*:\|/,
  // Curl-pipe-bash from any URL (we cannot vet the script).
  /\bcurl\b[^|&;]*\|\s*(?:sh|bash|zsh|pwsh|powershell)\b/i,
  /\bwget\b[^|&;]*\|\s*(?:sh|bash|zsh|pwsh|powershell)\b/i,
  // ── PowerShell equivalents (the default Windows shell here) ──
  // Recursive force-delete of a drive root or user profile.
  /\bRemove-Item\b[^\n]*-Recurse\b[^\n]*-Force\b[^\n]*(?:[a-z]:\\?|\$env:USERPROFILE|~)(?:\s|\\|"|'|$)/i,
  /\b(?:ri|rd|rmdir|del|erase)\b[^\n]*\b[a-z]:\\(?:\s|"|'|\*|$)/i,
  // Drive formatting / wipe.
  /\bFormat-Volume\b/i,
  /\bClear-Disk\b/i,
  // Power state.
  /\b(?:Stop-Computer|Restart-Computer)\b/i,
  // Download-and-execute (iwr/curl/wget alias → iex).
  /\b(?:iwr|curl|wget|Invoke-WebRequest)\b[^\n|]*\|\s*(?:iex|Invoke-Expression)\b/i,
  /\b(?:iex|Invoke-Expression)\b[^\n]*\b(?:iwr|Invoke-WebRequest|DownloadString|New-Object\s+Net\.WebClient)\b/i,
];

interface PendingApproval {
  resolve: (v: { approved: boolean; reason?: string }) => void;
  win: BrowserWindow;
}

const pendingApprovals = new Map<string, PendingApproval>();
const activeRuns = new Map<string, AbortController>();

export const terminal = {
  /**
   * Execute a shell command. Returns the captured output.
   * The caller is expected to be an authenticated context (agent tool,
   * preload-exposed IPC). All safety checks happen here.
   */
  async run(
    params: {
      command: string;
      requestId: string;
      cwd?: string;
      timeoutMs?: number;
    },
    win: BrowserWindow
  ): Promise<{
    ok: boolean;
    code?: number | null;
    stdout?: string;
    stderr?: string;
    error?: string;
    truncated?: boolean;
    durationMs?: number;
  }> {
    const settings = appSettings.get();
    if (!settings.agent.allowTerminal) {
      return {
        ok: false,
        error:
          'Terminal execution disabled. Enable it in Settings → Agent → "Allow terminal commands".',
      };
    }

    const command = (params.command || '').trim();
    if (!command) return { ok: false, error: 'empty command' };
    if (command.length > 4000) return { ok: false, error: 'command too long' };
    for (const re of HARD_DENY) {
      if (re.test(command)) {
        return {
          ok: false,
          error: `command rejected by hard denylist: matches ${re.source}`,
        };
      }
    }

    // Resolve cwd against workspace.
    const root = getActiveWorkspaceRoot();
    if (!root) return { ok: false, error: 'no workspace is open' };
    let cwd = root;
    if (params.cwd && params.cwd.trim()) {
      const r = safeResolveInWorkspace(params.cwd, root);
      if (!r.ok) return { ok: false, error: r.error };
      cwd = r.absolute!;
    }

    // Approval gate.
    if (settings.agent.requireApprovalForCommands) {
      const approval = await requestApproval({
        requestId: params.requestId,
        command,
        cwd,
        timeoutMs: params.timeoutMs ?? settings.agent.terminalTimeoutMs,
        win,
      });
      if (!approval.approved) {
        return { ok: false, error: `denied by user${approval.reason ? `: ${approval.reason}` : ''}` };
      }
    }

    // Actually run it.
    const timeoutMs = clamp(
      params.timeoutMs ?? settings.agent.terminalTimeoutMs,
      1000,
      30 * 60 * 1000
    );
    const maxBytes = clamp(settings.agent.terminalMaxOutputBytes, 1024, 5_000_000);
    return execShell(command, cwd, timeoutMs, maxBytes, params.requestId);
  },

  /**
   * Renderer responds to an approval request. Returns true if a request was
   * waiting for this requestId.
   */
  respondApproval(requestId: string, decision: { approved: boolean; reason?: string }): boolean {
    const pending = pendingApprovals.get(requestId);
    if (!pending) return false;
    pendingApprovals.delete(requestId);
    pending.resolve(decision);
    return true;
  },

  /** Kill the run owned by this requestId, if any. */
  abort(requestId: string): boolean {
    const pending = pendingApprovals.get(requestId);
    if (pending) {
      pendingApprovals.delete(requestId);
      pending.resolve({ approved: false, reason: 'aborted' });
    }
    const c = activeRuns.get(requestId);
    if (c) {
      c.abort();
      activeRuns.delete(requestId);
      return true;
    }
    return false;
  },
};

async function requestApproval(params: {
  requestId: string;
  command: string;
  cwd: string;
  timeoutMs: number;
  win: BrowserWindow;
}): Promise<{ approved: boolean; reason?: string }> {
  const { requestId, command, cwd, timeoutMs, win } = params;
  win.webContents.send('terminal:approval-request', {
    requestId,
    command,
    cwd,
    timeoutMs,
  });
  return new Promise((resolve) => {
    pendingApprovals.set(requestId, { resolve, win });
  });
}

async function execShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxBytes: number,
  requestId: string
): Promise<{
  ok: boolean;
  code?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
  truncated?: boolean;
  durationMs?: number;
}> {
  const start = Date.now();
  const controller = new AbortController();
  activeRuns.set(requestId, controller);

  const { cmd, args } = pickShell(command);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let killedByTimeout = false;

    const child = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      signal: controller.signal,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    });

    const timer = setTimeout(() => {
      killedByTimeout = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      const current = target === 'stdout' ? stdout : stderr;
      const room = Math.max(0, maxBytes - current.length);
      if (room === 0) {
        truncated = true;
        return;
      }
      const slice = chunk.slice(0, room).toString('utf-8');
      if (target === 'stdout') stdout = current + slice;
      else stderr = current + slice;
      if (chunk.length > room) truncated = true;
    };

    child.stdout?.on('data', (d: Buffer) => append('stdout', d));
    child.stderr?.on('data', (d: Buffer) => append('stderr', d));

    child.on('error', (err) => {
      clearTimeout(timer);
      activeRuns.delete(requestId);
      resolve({
        ok: false,
        error: err.message,
        durationMs: Date.now() - start,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      activeRuns.delete(requestId);
      if (killedByTimeout) {
        resolve({
          ok: false,
          code,
          stdout,
          stderr,
          truncated,
          error: `timed out after ${timeoutMs}ms`,
          durationMs: Date.now() - start,
        });
        return;
      }
      if (controller.signal.aborted) {
        resolve({
          ok: false,
          code,
          stdout,
          stderr,
          truncated,
          error: 'aborted',
          durationMs: Date.now() - start,
        });
        return;
      }
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr,
        truncated,
        durationMs: Date.now() - start,
      });
    });
  });
}

function pickShell(command: string): { cmd: string; args: string[] } {
  if (process.platform === 'win32') {
    // Use PowerShell when available — it understands more syntax than cmd.exe
    // and we already use it elsewhere. -NoProfile keeps cold-start fast.
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', command],
    };
  }
  return { cmd: '/bin/sh', args: ['-lc', command] };
}

function clamp(v: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
