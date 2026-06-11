import { app, BrowserWindow, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpcHandlers } from './ipc-handlers.js';
import { maybeAutoStartOllama } from './services/ollama-launcher.js';
import { isSafeExternalUrl } from './services/path-safety.js';
import { mcp } from './services/mcp.js';
import { updater } from './services/updater.js';
import { cwmMedia } from './services/cwm-media.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function log(message: string, error?: unknown) {
  try {
    const logPath = path.join(app.getPath('userData'), 'debug.log');
    const suffix = error instanceof Error ? `\n${error.stack || error.message}` : error ? `\n${String(error)}` : '';
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}${suffix}\n`, 'utf-8');
  } catch {
    // Logging should never prevent startup.
  }
}

process.on('uncaughtException', (err) => log('uncaughtException', err));
process.on('unhandledRejection', (err) => log('unhandledRejection', err));

process.env.APP_ROOT = path.join(__dirname, '..');
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist');
const APP_ICON = path.join(process.env.APP_ROOT, 'build', 'icon.ico');

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  log(`createWindow start. appRoot=${process.env.APP_ROOT} renderer=${RENDERER_DIST} devUrl=${VITE_DEV_SERVER_URL || 'none'}`);
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1024,
    minHeight: 600,
    title: 'CodeDert',
    icon: fs.existsSync(APP_ICON) ? APP_ICON : undefined,
    backgroundColor: '#0d1117',
    frame: true,
    titleBarStyle: 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Kept false: the vite-plugin-electron preload bundle is emitted with an
      // ESM `import` that a sandboxed preload loader rejects ("Cannot use import
      // statement outside a module"), which breaks window.api entirely. The
      // main hardening (contextIsolation + nodeIntegration:false) is already in
      // place; enabling sandbox would require reworking the preload build.
      sandbox: false,
    },
  });

  // Open external links in default browser — only safe web/email schemes.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Never let the renderer navigate the top frame away from the app.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (VITE_DEV_SERVER_URL && url.startsWith(VITE_DEV_SERVER_URL)) return;
    event.preventDefault();
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    log(`did-fail-load ${errorCode} ${errorDescription} ${validatedURL}`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`render-process-gone ${JSON.stringify(details)}`);
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    log(`renderer console [${level}] ${message} (${sourceId}:${line})`);
  });

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    const indexPath = path.join(RENDERER_DIST, 'index.html');
    log(`loading file ${indexPath} exists=${fs.existsSync(indexPath)}`);
    mainWindow.loadFile(indexPath);
  }

  // Register IPC handlers that need access to window
  registerIpcHandlers(mainWindow);

  // Auto-update: silent check against GitHub Releases (packaged builds only).
  updater.init(mainWindow);
}

app.whenReady().then(() => {
  log('app ready');
  createWindow();

  // Housekeeping: drop CWM-generated media older than 30 days.
  cwmMedia.cleanupOldMedia(30).catch((err) => log('cwm media cleanup failed', err));

  // Try to auto-launch Ollama in the background. Result is reported to the
  // renderer over the `ollama:auto-start` channel so onboarding/settings can
  // surface it. Fire-and-forget — the UI works regardless.
  maybeAutoStartOllama()
    .then((res) => {
      log(`ollama auto-start: ${JSON.stringify(res)}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ollama:auto-start', res);
      }
    })
    .catch((err) => log('ollama auto-start failed', err));

  // Stable Diffusion is NOT auto-started: the webui is heavy (GPU, minutes of
  // boot time). It launches only when the user explicitly clicks "Запустить"
  // in the image panel (sd:ensure-running IPC).

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('will-quit', () => {
  // Kill all spawned MCP server processes — no orphans.
  try {
    mcp.shutdown();
  } catch {
    /* ignore */
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
  mainWindow = null;
});

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
