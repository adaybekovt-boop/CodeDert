import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { appSettings } from './settings.js';

/**
 * Launch the AUTOMATIC1111 Stable Diffusion webui from inside the app, the same
 * way `ollama-launcher` brings up Ollama.
 *
 * Two install layouts are supported:
 *   - **portable** (`sd.webui`): bundled python at `system/python/python.exe`
 *     and the app at `webui/launch.py`. We launch python directly with a known
 *     -good environment (this avoids the flaky `run.bat` requirement re-checks).
 *   - **classic** (`stable-diffusion-webui`): launched via run.bat/webui-user.bat,
 *     auto-patching `--api` into webui-user.bat first.
 *
 * We do NOT block waiting for the server to finish loading — the renderer polls
 * health itself.
 */

export interface SdLaunchResult {
  ok: boolean;
  alreadyRunning?: boolean;
  spawned?: boolean;
  webuiPath?: string;
  command?: string;
  patchedApi?: boolean;
  error?: string;
}

function sdBaseUrl(): string {
  return appSettings.get().provider.sd.baseUrl.replace(/\/+$/, '');
}

async function isApiUp(timeoutMs = 2500): Promise<boolean> {
  try {
    const res = await fetch(`${sdBaseUrl()}/sdapi/v1/sd-models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Candidate folders that may contain a webui install. */
function candidateDirs(): string[] {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const configured = appSettings.get().provider.sd.webuiPath?.trim();
  const list: string[] = [];
  if (configured) list.push(configured);
  if (home) {
    for (const name of ['sd.webui', 'stable-diffusion-webui', 'stable-diffusion']) {
      list.push(path.join(home, 'Downloads', name));
      list.push(path.join(home, 'Desktop', name));
      list.push(path.join(home, name));
    }
  }
  return list;
}

type WebuiLayout =
  | {
      kind: 'portable';
      dir: string;
      python: string;
      webuiDir: string;
    }
  | {
      kind: 'bat';
      dir: string;
      entry: string;
      userBat: string | null;
    };

/** Identify a usable webui layout in `dir`, or null. */
function inspectDir(dir: string): WebuiLayout | null {
  if (!dir || !fs.existsSync(dir)) return null;

  // Portable package (sd.webui): bundled python + webui/launch.py.
  const portablePython = path.join(dir, 'system', 'python', 'python.exe');
  const portableLaunch = path.join(dir, 'webui', 'launch.py');
  if (fs.existsSync(portablePython) && fs.existsSync(portableLaunch)) {
    return { kind: 'portable', dir, python: portablePython, webuiDir: path.join(dir, 'webui') };
  }

  if (process.platform === 'win32') {
    if (fs.existsSync(path.join(dir, 'run.bat'))) {
      const nested = path.join(dir, 'webui', 'webui-user.bat');
      const flat = path.join(dir, 'webui-user.bat');
      return {
        kind: 'bat',
        dir,
        entry: 'run.bat',
        userBat: fs.existsSync(nested) ? nested : fs.existsSync(flat) ? flat : null,
      };
    }
    if (fs.existsSync(path.join(dir, 'webui-user.bat'))) {
      return { kind: 'bat', dir, entry: 'webui-user.bat', userBat: path.join(dir, 'webui-user.bat') };
    }
    if (fs.existsSync(path.join(dir, 'webui.bat'))) {
      return { kind: 'bat', dir, entry: 'webui.bat', userBat: null };
    }
    return null;
  }

  if (fs.existsSync(path.join(dir, 'webui.sh'))) {
    return { kind: 'bat', dir, entry: 'webui.sh', userBat: null };
  }
  return null;
}

function resolveWebui(): WebuiLayout | null {
  for (const dir of candidateDirs()) {
    const layout = inspectDir(dir);
    if (layout) return layout;
  }
  return null;
}

/**
 * Ensure `--api` is in a classic webui's COMMANDLINE_ARGS. Returns true if it
 * patched the file. (Portable layout passes --api directly, no patch needed.)
 */
function ensureApiFlag(userBat: string | null): boolean {
  if (!userBat || !fs.existsSync(userBat)) return false;
  try {
    let content = fs.readFileSync(userBat, 'utf-8');
    if (/--api(\s|$)/m.test(content)) return false;
    if (/^\s*set\s+COMMANDLINE_ARGS=.*/im.test(content)) {
      content = content.replace(
        /^(\s*set\s+COMMANDLINE_ARGS=.*)$/im,
        (line) => `${line.replace(/\s+$/, '')} --api`
      );
    } else {
      content = content.replace(/^(\s*call\s+webui\.bat.*)$/im, 'set COMMANDLINE_ARGS=--api\r\n$1');
      if (!/--api/.test(content)) content += '\r\nset COMMANDLINE_ARGS=--api\r\n';
    }
    fs.writeFileSync(userBat, content, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

function spawnDetached(layout: WebuiLayout): string {
  if (layout.kind === 'portable') {
    const root = layout.dir;
    const env = {
      ...process.env,
      PATH: [
        path.join(root, 'system', 'python'),
        path.join(root, 'system', 'python', 'Scripts'),
        path.join(root, 'system', 'git', 'bin'),
        process.env.PATH || '',
      ].join(path.delimiter),
      SKIP_VENV: '1',
      PIP_NO_BUILD_ISOLATION: '1',
      STABLE_DIFFUSION_REPO: 'https://github.com/w-e-w/stablediffusion.git',
      GIT_TERMINAL_PROMPT: '0',
      PIP_INSTALLER_LOCATION: path.join(root, 'system', 'python', 'get-pip.py'),
    };
    const child = spawn(
      layout.python,
      ['launch.py', '--xformers', '--api', '--skip-torch-cuda-test'],
      { cwd: layout.webuiDir, env, detached: true, windowsHide: true, stdio: 'ignore' }
    );
    child.unref();
    return `python launch.py --api (in ${layout.webuiDir})`;
  }

  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/c', layout.entry], {
      cwd: layout.dir,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.unref();
    return `cmd /c ${layout.entry} (in ${layout.dir})`;
  }

  const child = spawn('bash', [layout.entry], { cwd: layout.dir, detached: true, stdio: 'ignore' });
  child.unref();
  return `bash ${layout.entry} (in ${layout.dir})`;
}

let inFlight: Promise<SdLaunchResult> | null = null;

export const sdLauncher = {
  /** Idempotent: concurrent callers share the in-flight launch. */
  ensureRunning(): Promise<SdLaunchResult> {
    if (inFlight) return inFlight;
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  },
};

async function run(): Promise<SdLaunchResult> {
  if (await isApiUp()) {
    return { ok: true, alreadyRunning: true };
  }

  const layout = resolveWebui();
  if (!layout) {
    return {
      ok: false,
      error:
        'Stable Diffusion webui не найден. Укажи путь к папке в Settings → Image, либо положи её в Downloads/sd.webui.',
    };
  }

  const patchedApi = layout.kind === 'bat' ? ensureApiFlag(layout.userBat) : false;

  let command: string;
  try {
    command = spawnDetached(layout);
  } catch (err: any) {
    return {
      ok: false,
      webuiPath: layout.dir,
      patchedApi,
      error: `Не удалось запустить webui: ${err.message || err}`,
    };
  }

  return { ok: true, spawned: true, webuiPath: layout.dir, command, patchedApi };
}

/**
 * Respects the `provider.sd.autoStart` setting — silently no-ops when off.
 * Called from main.ts on app launch (like maybeAutoStartOllama).
 */
export async function maybeAutoStartSd(): Promise<SdLaunchResult | { ok: false; error: string }> {
  if (!appSettings.get().provider.sd.autoStart) {
    return { ok: false, error: 'autoStart disabled' };
  }
  return sdLauncher.ensureRunning();
}
