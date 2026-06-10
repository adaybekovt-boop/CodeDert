import Store from 'electron-store';
import {
  AppSettings,
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
} from './settings-schema.js';

const store = new Store({ name: 'codedert-app-settings' });
const KEY = 'app';

let cache: AppSettings | null = null;

function load(): AppSettings {
  if (cache) return cache;
  const raw = store.get(KEY);
  cache = normalizeAppSettings(raw ?? DEFAULT_APP_SETTINGS);
  return cache;
}

export const appSettings = {
  get(): AppSettings {
    return load();
  },

  /** Deep-ish merge: top-level sections are merged, leaves replace wholesale. */
  patch(patch: Partial<AppSettings>): AppSettings {
    const current = load();
    const merged: AppSettings = {
      ...current,
      ...patch,
      provider: {
        ollama: { ...current.provider.ollama, ...(patch.provider?.ollama || {}) },
        sd: { ...current.provider.sd, ...(patch.provider?.sd || {}) },
      },
      models: { ...current.models, ...(patch.models || {}) },
      tuning: { ...current.tuning, ...(patch.tuning || {}) },
      agent: { ...current.agent, ...(patch.agent || {}) },
      workspace: { ...current.workspace, ...(patch.workspace || {}) },
      performance: { ...current.performance, ...(patch.performance || {}) },
      brain: { ...current.brain, ...(patch.brain || {}) },
    };
    const normalized = normalizeAppSettings(merged);
    store.set(KEY, normalized);
    cache = normalized;
    return normalized;
  },

  reset(): AppSettings {
    store.set(KEY, DEFAULT_APP_SETTINGS);
    cache = { ...DEFAULT_APP_SETTINGS };
    return cache;
  },
};
