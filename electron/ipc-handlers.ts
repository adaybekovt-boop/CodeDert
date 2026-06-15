import { ipcMain, BrowserWindow, shell } from 'electron';
import Store from 'electron-store';
import path from 'node:path';
import { workspace, setActiveWorkspaceRoot, getActiveWorkspaceRoot } from './services/workspace.js';
import { providers } from './services/providers.js';
import { mcp } from './services/mcp.js';
import { updater } from './services/updater.js';
import { ollama } from './services/ollama.js';
import { ollamaLauncher } from './services/ollama-launcher.js';
import { anthropic } from './services/anthropic.js';
import { stableDiffusion } from './services/stable-diffusion.js';
import { sdLauncher } from './services/sd-launcher.js';
import { probeHardware } from './services/hardware-probe.js';
import { recommendModels } from './services/model-recommender.js';
import { opusPlan } from './services/opus-plan.js';
import { agent } from './services/agent.js';
import { aiMutex } from './services/ai-mutex.js';
import { appSettings } from './services/settings.js';
import { cdesign } from './services/cdesign.js';
import { terminal } from './services/terminal.js';
import { brain } from './services/brain.js';
import { isSafeExternalUrl } from './services/path-safety.js';
import { generateProjectMap } from './services/project-map.js';
import { cwmSessions, type CwmSessionDoc } from './services/cwm-sessions.js';
import { cwmMedia } from './services/cwm-media.js';
import type { AppSettings } from './services/settings-schema.js';
import {
  multyplan,
  DEFAULT_MULTYPLAN_CONFIG,
  normalizeMultyplanConfig,
  type MultyplanConfig,
} from './services/multyplan.js';
import {
  ultrathink,
  DEFAULT_ULTRATHINK_CONFIG,
  normalizeUltrathinkConfig,
  type UltrathinkModelChoice,
} from './services/ultrathink.js';

const store = new Store({ name: 'codedert-settings' });

export function registerIpcHandlers(win: BrowserWindow) {
  // ── Hardware ──────────────────────────────────────────────
  ipcMain.handle('hardware:probe', async () => probeHardware());
  ipcMain.handle('hardware:recommend-models', async () => {
    const hw = await probeHardware();
    const models = recommendModels(hw.tier);
    return { hardware: hw, models };
  });

  // ── Workspace ─────────────────────────────────────────────
  ipcMain.handle('workspace:open-folder', async () => {
    const res = await workspace.openFolder(win);
    // Main-side record of the user-chosen root. `workspace:set-root` is
    // validated against this so a compromised renderer cannot point file
    // APIs at an arbitrary directory (e.g. C:\).
    if (res?.root) store.set('lastWorkspaceRootMain', res.root);
    return res;
  });
  ipcMain.handle('workspace:set-root', async (_, root: string | null) => {
    if (root == null) {
      setActiveWorkspaceRoot(null);
      return true;
    }
    if (typeof root !== 'string') return false;
    const allowed = store.get('lastWorkspaceRootMain');
    if (typeof allowed === 'string' && allowed) {
      // Windows paths are case-insensitive and path.resolve does NOT normalize
      // drive-letter case (C:\ vs c:\). A byte-exact compare would wrongly
      // reject a valid restore on boot, leaving activeWorkspaceRoot null so
      // every read/write silently fails ("can't open my code"). Compare
      // case-insensitively on win32 only.
      const a = path.resolve(allowed);
      const b = path.resolve(root);
      const same = process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
      if (!same) return false;
    } else {
      // One-time migration for installs that predate main-side tracking.
      store.set('lastWorkspaceRootMain', root);
    }
    setActiveWorkspaceRoot(root);
    return true;
  });
  ipcMain.handle('workspace:list-files', async (_, root: string) => workspace.listFiles(root));
  ipcMain.handle('workspace:read-file', async (_, filePath: string) => workspace.readFile(filePath));
  ipcMain.handle('workspace:write-file', async (_, filePath: string, content: string) =>
    workspace.writeFile(filePath, content)
  );
  ipcMain.handle('workspace:create-file', async (_, filePath: string, content: string) =>
    workspace.createFile(filePath, content)
  );
  ipcMain.handle(
    'workspace:apply-edit',
    async (_, filePath: string, oldString: string, newString: string, replaceAll?: boolean) =>
      workspace.applyEdit(filePath, oldString, newString, !!replaceAll)
  );
  ipcMain.handle('workspace:list-dir', async (_, dirPath: string) => workspace.listDirectory(dirPath));
  ipcMain.handle('workspace:delete-file', async (_, filePath: string) => workspace.deleteFile(filePath));
  ipcMain.handle('workspace:project-map', async (_, root: string) => {
    try {
      // Same trust model as the other workspace handlers: only scan the
      // folder the user actually opened, never an arbitrary renderer path.
      const active = getActiveWorkspaceRoot();
      if (!active || typeof root !== 'string' || path.resolve(root) !== path.resolve(active)) {
        return {
          text: '',
          graph: { nodes: [], edges: [], rootName: '' },
          generatedAt: Date.now(),
          root,
          error: 'root is not the active workspace',
        };
      }
      return await generateProjectMap(active);
    } catch (err: any) {
      return {
        text: '',
        graph: { nodes: [], edges: [], rootName: '' },
        generatedAt: Date.now(),
        root,
        error: err.message,
      };
    }
  });

  // ── Agent ─────────────────────────────────────────────────
  // workspaceRoot is taken from the main-process source of truth, never from
  // the renderer payload.
  ipcMain.handle('agent:chat', async (_, params) =>
    agent.chat({ ...params, workspaceRoot: getActiveWorkspaceRoot() }, win)
  );
  ipcMain.handle('agent:abort', (_, requestId: string) => agent.abort(requestId));
  ipcMain.handle(
    'agent:ask-respond',
    (_, askId: string, decision: { answered: boolean; text?: string }) =>
      agent.respondAsk(askId, decision)
  );

  // ── Ollama ────────────────────────────────────────────────
  ipcMain.handle('ollama:health', () => ollama.health());
  ipcMain.handle('ollama:list', () => ollama.list());
  ipcMain.handle('ollama:pull', async (_, model: string) =>
    ollama.pull(model, (status, percent) => {
      win.webContents.send('ollama:pull-progress', { model, status, percent });
    })
  );
  ipcMain.handle('ollama:test-model', (_, model: string) => ollama.testModel(model));
  ipcMain.handle('ollama:chat', async (_, params) => {
    const lock = aiMutex.acquire('ollama-chat', params.requestId, () => ollama.abort(params.requestId));
    if (!lock.ok) {
      win.webContents.send('ollama:chunk', {
        requestId: params.requestId,
        type: 'error',
        content: lock.error || 'another AI task is running',
      });
      return { ok: false, error: lock.error };
    }

    try {
      return await ollama.chat(params, win);
    } finally {
      lock.release?.();
    }
  });
  ipcMain.handle('ollama:abort', (_, requestId: string) => ollama.abort(requestId));
  ipcMain.handle('ollama:unload', (_, model: string) => ollama.unload(model));
  ipcMain.handle('ollama:ensure-running', () => ollamaLauncher.ensureRunning());

  // ── Anthropic ─────────────────────────────────────────────
  ipcMain.handle('anthropic:has-key', () => anthropic.hasKey());
  ipcMain.handle('anthropic:set-key', (_, key: string) => anthropic.setKey(key));
  ipcMain.handle('anthropic:clear-key', () => anthropic.clearKey());
  ipcMain.handle('anthropic:test-key', () => anthropic.testKey());
  ipcMain.handle('anthropic:chat', (_, params) => anthropic.chat(params, win));

  // ── Stable Diffusion ──────────────────────────────────────
  ipcMain.handle('sd:health', () => stableDiffusion.health());
  ipcMain.handle('sd:list-models', () => stableDiffusion.listModels());
  ipcMain.handle('sd:set-model', (_, title: string) => stableDiffusion.setModel(title));
  ipcMain.handle('sd:txt2img', (_, params) => stableDiffusion.txt2img(params));
  ipcMain.handle('sd:save-image', (_, base64: string, savePath: string) =>
    stableDiffusion.saveImage(base64, savePath)
  );
  ipcMain.handle('sd:ensure-running', () => sdLauncher.ensureRunning());

  // ── Opus Plan ─────────────────────────────────────────────
  ipcMain.handle('opus-plan:run', (_, params) =>
    opusPlan.run({ ...params, workspaceRoot: getActiveWorkspaceRoot() as any }, win)
  );

  // ── Cloud providers (OpenRouter / Groq / NVIDIA / OpenAI / Gemini / xAI /
  //     Moonshot / DeepSeek / Qwen / Anthropic / custom) ──────
  ipcMain.handle('providers:status', () => providers.status());
  ipcMain.handle('providers:set-key', (_, providerId: string, key: string) =>
    providers.setKey(providerId, key)
  );
  ipcMain.handle('providers:clear-key', (_, providerId: string) => providers.clearKey(providerId));
  ipcMain.handle('providers:refresh-models', (_, providerId: string) =>
    providers.refreshModels(providerId)
  );
  ipcMain.handle('providers:all-models', () => providers.allModels());
  ipcMain.handle('providers:set-base-url', (_, providerId: string, url: string) =>
    providers.setBaseUrl(providerId, url)
  );
  ipcMain.handle('providers:chat', async (_, params) => {
    const lock = aiMutex.acquire('providers-chat', params.requestId, () =>
      providers.abort(params.requestId)
    );
    if (!lock.ok) {
      win.webContents.send('providers:chunk', {
        requestId: params.requestId,
        chunk: '',
        type: 'text',
        done: true,
        error: lock.error || 'another AI task is running',
      });
      return { ok: false, error: lock.error };
    }
    try {
      return await providers.chat(params, win);
    } finally {
      lock.release?.();
    }
  });
  ipcMain.handle('providers:abort', (_, requestId: string) => providers.abort(requestId));

  // ── Auto-update (GitHub Releases) ─────────────────────────
  ipcMain.handle('updater:state', () => updater.state());
  ipcMain.handle('updater:check', () => updater.check());
  ipcMain.handle('updater:download', () => updater.download());
  ipcMain.handle('updater:install', () => {
    updater.install();
    return true;
  });

  // ── MCP servers ───────────────────────────────────────────
  ipcMain.handle('mcp:status', () => mcp.status());
  ipcMain.handle('mcp:sync', async () => {
    await mcp.sync();
    return mcp.status();
  });
  ipcMain.handle('mcp:list-tools', () => mcp.listAllTools());

  // ── Multyplan ────────────────────────────────────────────
  ipcMain.handle('multyplan:get-config', () => {
    const stored = (store.get('multyplan') as Partial<MultyplanConfig>) || {};
    return normalizeMultyplanConfig({
      ...DEFAULT_MULTYPLAN_CONFIG,
      ...stored,
      models: { ...DEFAULT_MULTYPLAN_CONFIG.models, ...(stored.models || {}) },
    });
  });
  ipcMain.handle('multyplan:set-config', (_, patch: Partial<MultyplanConfig>) => {
    const current = (store.get('multyplan') as Partial<MultyplanConfig>) || {};
    const next = normalizeMultyplanConfig({
      ...DEFAULT_MULTYPLAN_CONFIG,
      ...current,
      ...patch,
      models: {
        ...DEFAULT_MULTYPLAN_CONFIG.models,
        ...(current.models || {}),
        ...(patch.models || {}),
      },
    });
    store.set('multyplan', next);
    return next;
  });
  ipcMain.handle('multyplan:start', (_, params) =>
    multyplan.start({ ...params, workspaceRoot: getActiveWorkspaceRoot() as any }, win)
  );
  ipcMain.handle(
    'multyplan:approve',
    (_, requestId: string, decision: { approved: boolean; edits?: string }) =>
      multyplan.approve(requestId, decision)
  );
  ipcMain.handle('multyplan:cancel', (_, requestId: string) => multyplan.cancel(requestId));

  // ── Ultrathink ────────────────────────────────────────────
  ipcMain.handle('ultrathink:get-config', () => {
    const stored = (store.get('ultrathink') as Partial<typeof DEFAULT_ULTRATHINK_CONFIG>) || {};
    return normalizeUltrathinkConfig({
      ...DEFAULT_ULTRATHINK_CONFIG,
      ...stored,
      models: { ...DEFAULT_ULTRATHINK_CONFIG.models, ...(stored.models || {}) },
    });
  });
  ipcMain.handle('ultrathink:set-config', (_, patch: Partial<typeof DEFAULT_ULTRATHINK_CONFIG>) => {
    const current = (store.get('ultrathink') as Partial<typeof DEFAULT_ULTRATHINK_CONFIG>) || {};
    const next = normalizeUltrathinkConfig({
      ...DEFAULT_ULTRATHINK_CONFIG,
      ...current,
      ...patch,
      models: {
        ...DEFAULT_ULTRATHINK_CONFIG.models,
        ...(current.models || {}),
        ...(patch.models || {}),
      },
    });
    store.set('ultrathink', next);
    return next;
  });
  ipcMain.handle(
    'ultrathink:start',
    (
      _,
      params: {
        task: string;
        workspaceRoot: string;
        requestId: string;
        modelChoice: UltrathinkModelChoice;
        config: typeof DEFAULT_ULTRATHINK_CONFIG;
      }
    ) => ultrathink.start({ ...params, workspaceRoot: getActiveWorkspaceRoot() as any }, win)
  );
  ipcMain.handle('ultrathink:cancel', (_, requestId: string) => ultrathink.cancel(requestId));

  // ── App-level settings ────────────────────────────────────
  ipcMain.handle('app-settings:get', () => appSettings.get());
  ipcMain.handle('app-settings:patch', (_, patch: Partial<AppSettings>) => {
    const next = appSettings.patch(patch);
    // Apply MCP server changes immediately (fire-and-forget; status is polled).
    if (patch && (patch as any).mcp) mcp.sync().catch(() => {});
    return next;
  });
  ipcMain.handle('app-settings:reset', () => appSettings.reset());

  // ── Global AI control ─────────────────────────────────────
  ipcMain.handle('ai:current', () => aiMutex.current());
  ipcMain.handle('ai:stop', () => aiMutex.cancelCurrent());

  // ── Brain graph ───────────────────────────────────────────
  const offBrain = brain.onChange((state) => {
    if (!win.isDestroyed()) win.webContents.send('brain:state', state);
  });
  win.on('closed', () => offBrain());

  ipcMain.handle('brain:state', () => brain.state());
  ipcMain.handle('brain:stats', () => brain.stats());
  ipcMain.handle('brain:list-nodes', (_, filter) => brain.listNodes(filter));
  ipcMain.handle('brain:get-node', (_, nodeId: string) => brain.getNode(nodeId));
  ipcMain.handle('brain:create-node', (_, input) => brain.createNode(input));
  ipcMain.handle('brain:update-node', (_, nodeId: string, patch) => brain.updateNode(nodeId, patch));
  ipcMain.handle('brain:delete-node', (_, nodeId: string) => brain.deleteNode(nodeId));
  ipcMain.handle('brain:list-edges', () => brain.listEdges());
  ipcMain.handle('brain:create-edge', (_, input) => brain.createEdge(input));
  ipcMain.handle('brain:delete-edge', (_, edgeId: string) => brain.deleteEdge(edgeId));
  ipcMain.handle('brain:list-suggestions', (_, status) => brain.listSuggestions(status));
  ipcMain.handle(
    'brain:resolve-suggestion',
    (_, suggestionId: string, decision: 'accept' | 'ignore', edits?: any) =>
      brain.resolveSuggestion(suggestionId, decision, edits)
  );
  ipcMain.handle('brain:clear-resolved', () => brain.clearResolvedSuggestions());
  ipcMain.handle('brain:propose-from-chat', (_, input) => brain.proposeFromChat(input));
  ipcMain.handle('brain:search', (_, query: string, limit?: number) =>
    brain.search(query, limit)
  );
  ipcMain.handle('brain:related', (_, nodeId: string, limit?: number) =>
    brain.related(nodeId, limit)
  );
  ipcMain.handle('brain:retrieve-for-prompt', (_, prompt: string, limit?: number) =>
    brain.retrieveForPrompt(prompt, limit)
  );
  ipcMain.handle('brain:forget', (_, query: string) => brain.forget(query));
  ipcMain.handle('brain:set-project', (_, root: string | null) => brain.setActiveProject(root));
  ipcMain.handle('brain:active-project', () => brain.activeProject());
  ipcMain.handle('brain:set-show-all', (_, show: boolean) => brain.setShowAllProjects(show));
  ipcMain.handle('brain:worklog', (_, root: string | null, limit?: number) => brain.worklog(root, limit));
  ipcMain.handle('brain:export', () => brain.export());
  ipcMain.handle('brain:import', (_, blob, mode) => brain.import(blob, mode));

  // ── Terminal exec ─────────────────────────────────────────
  ipcMain.handle(
    'terminal:run',
    (
      _,
      params: { command: string; requestId: string; cwd?: string; timeoutMs?: number }
    ) => terminal.run(params, win)
  );
  ipcMain.handle(
    'terminal:respond',
    (_, requestId: string, decision: { approved: boolean; reason?: string }) =>
      terminal.respondApproval(requestId, decision)
  );
  ipcMain.handle('terminal:abort', (_, requestId: string) => terminal.abort(requestId));

  // ── /cdesign skill ────────────────────────────────────────
  ipcMain.handle('cdesign:get-system-prompt', () => cdesign.getSystemPrompt());
  ipcMain.handle('cdesign:list-recipes', () => cdesign.listRecipes());
  ipcMain.handle('cdesign:read-recipe', (_, name: string) => cdesign.readRecipe(name));
  ipcMain.handle('cdesign:scaffold', (_, targetDir: string) => cdesign.scaffoldStarter(targetDir));
  ipcMain.handle('cdesign:paths', () => cdesign.paths());

  // ── Legacy raw settings (whitelisted keys only) ──────────
  // The renderer used to read/write arbitrary store keys. We now restrict it
  // to the small set of UI-preference keys actually in use, so a compromised
  // renderer cannot read or clobber unrelated persisted state.
  const LEGACY_SETTINGS_KEYS = new Set([
    'selectedModelId',
    'lastWorkspaceRoot',
    'onboardingDone',
    // CWM UI preferences (model + media providers picked inside the chat).
    'cwmSelectedModelId',
    'cwmImageProviderId',
    'cwmVideoProviderId',
  ]);
  ipcMain.handle('settings:get', (_, key: string) =>
    LEGACY_SETTINGS_KEYS.has(key) ? store.get(key) : undefined
  );
  ipcMain.handle('settings:set', (_, key: string, value: any) => {
    if (!LEGACY_SETTINGS_KEYS.has(key)) return false;
    store.set(key, value);
    return true;
  });
  ipcMain.handle('settings:all', () => {
    const out: Record<string, unknown> = {};
    for (const key of LEGACY_SETTINGS_KEYS) {
      const v = store.get(key);
      if (v !== undefined) out[key] = v;
    }
    return out;
  });

  // ── Chat With Model (CWM) ─────────────────────────────────
  // Conversational mode. Deliberately NOT wired to agent/workspace/terminal:
  // its only main-process surface is session storage + media generation.
  // Chat itself reuses the providers/ollama channels (no tool definitions).
  ipcMain.handle('cwm:list-sessions', () => cwmSessions.list());
  ipcMain.handle('cwm:get-session', (_, id: string) => cwmSessions.get(id));
  ipcMain.handle('cwm:save-session', (_, doc: CwmSessionDoc) => cwmSessions.save(doc));
  ipcMain.handle('cwm:delete-session', (_, id: string) => cwmSessions.delete(id));
  ipcMain.handle('cwm:image-providers', () => cwmMedia.imageProviders());
  ipcMain.handle('cwm:video-providers', () => cwmMedia.videoProviders());
  ipcMain.handle('cwm:generate-image', (_, params) => cwmMedia.generateImage(params, win));
  ipcMain.handle('cwm:generate-video', (_, params) => cwmMedia.generateVideo(params, win));
  ipcMain.handle('cwm:cancel-media', (_, jobId: string) => cwmMedia.cancel(jobId));
  ipcMain.handle('cwm:save-media-as', (_, filePath: string) => cwmMedia.saveAs(filePath, win));
  ipcMain.handle('cwm:read-media', (_, filePath: string) => cwmMedia.readMedia(filePath));

  // ── External ──────────────────────────────────────────────
  ipcMain.handle('external:open', (_, url: string) => {
    if (!isSafeExternalUrl(url)) return false;
    shell.openExternal(url);
    return true;
  });
}
