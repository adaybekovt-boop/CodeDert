/**
 * Auto-update via GitHub Releases (electron-updater).
 *
 * Flow:
 *   1. On app start (packaged builds only) — silent check against the
 *      GitHub repo configured in package.json `build.publish`.
 *   2. If a newer release exists, the renderer gets an 'updater:event'
 *      with { type: 'available', version, notes } and shows a banner.
 *   3. User clicks "Обновить" → differential download in background
 *      (blockmap — only changed parts are fetched, not the whole installer).
 *   4. When downloaded → "Перезапустить и установить" → quitAndInstall()
 *      runs the NSIS updater silently. No manual file juggling.
 *
 * Dev mode (`!app.isPackaged`) is a no-op: there is no app-update.yml and
 * nothing to update.
 */
import { app, type BrowserWindow } from 'electron';
import electronUpdaterPkg from 'electron-updater';

const { autoUpdater } = electronUpdaterPkg;

export interface UpdaterState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  version?: string;
  notes?: string;
  percent?: number;
  error?: string;
  currentVersion: string;
}

let win: BrowserWindow | null = null;
let wired = false;
const state: UpdaterState = { status: 'idle', currentVersion: app.getVersion() };

function emit(patch: Partial<UpdaterState>) {
  Object.assign(state, patch);
  if (win && !win.isDestroyed()) {
    win.webContents.send('updater:event', { ...state });
  }
}

function releaseNotesToText(notes: unknown): string {
  if (typeof notes === 'string') return notes.slice(0, 2000);
  if (Array.isArray(notes)) {
    return notes
      .map((n: any) => (typeof n?.note === 'string' ? n.note : ''))
      .filter(Boolean)
      .join('\n')
      .slice(0, 2000);
  }
  return '';
}

function wire() {
  if (wired) return;
  wired = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => emit({ status: 'checking', error: undefined }));
  autoUpdater.on('update-available', (info) =>
    emit({
      status: 'available',
      version: info.version,
      notes: releaseNotesToText(info.releaseNotes),
      percent: 0,
    })
  );
  autoUpdater.on('update-not-available', () => emit({ status: 'not-available' }));
  autoUpdater.on('download-progress', (p) =>
    emit({ status: 'downloading', percent: Math.round(p.percent) })
  );
  autoUpdater.on('update-downloaded', (info) =>
    emit({ status: 'downloaded', version: info.version, percent: 100 })
  );
  autoUpdater.on('error', (err) =>
    emit({ status: 'error', error: (err?.message || String(err)).slice(0, 300) })
  );
}

export const updater = {
  /** Call once after the main window is created. */
  init(window: BrowserWindow): void {
    win = window;
    if (!app.isPackaged) return; // dev build — nothing to update
    wire();
    // Initial silent check, slightly delayed so it never competes with boot.
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        emit({ status: 'error', error: (err?.message || String(err)).slice(0, 300) });
      });
    }, 4000);
  },

  state(): UpdaterState {
    return { ...state };
  },

  async check(): Promise<UpdaterState> {
    if (!app.isPackaged) {
      return { ...state, status: 'error', error: 'dev-режим: обновления доступны только в собранном приложении' };
    }
    wire();
    try {
      await autoUpdater.checkForUpdates();
    } catch (err: any) {
      emit({ status: 'error', error: (err?.message || String(err)).slice(0, 300) });
    }
    return { ...state };
  },

  async download(): Promise<{ ok: boolean; error?: string }> {
    if (!app.isPackaged) return { ok: false, error: 'dev-режим' };
    try {
      emit({ status: 'downloading', percent: 0 });
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err: any) {
      const msg = (err?.message || String(err)).slice(0, 300);
      emit({ status: 'error', error: msg });
      return { ok: false, error: msg };
    }
  },

  /** Quit and run the silent installer of the downloaded update. */
  install(): void {
    if (!app.isPackaged) return;
    autoUpdater.quitAndInstall(false, true);
  },
};
