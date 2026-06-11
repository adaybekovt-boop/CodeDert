import { contextBridge, ipcRenderer } from 'electron';

/**
 * Exposed to renderer as `window.api`.
 * All IPC must go through here — no nodeIntegration in renderer.
 */
const api = {
  // ── System / hardware ─────────────────────────────────────
  hardware: {
    probe: () => ipcRenderer.invoke('hardware:probe'),
    recommendModels: () => ipcRenderer.invoke('hardware:recommend-models'),
  },

  // ── Workspace / files ────────────────────────────────────
  workspace: {
    openFolder: () => ipcRenderer.invoke('workspace:open-folder'),
    setRoot: (root: string | null) => ipcRenderer.invoke('workspace:set-root', root),
    listFiles: (root: string) => ipcRenderer.invoke('workspace:list-files', root),
    readFile: (filePath: string) => ipcRenderer.invoke('workspace:read-file', filePath),
    writeFile: (filePath: string, content: string) =>
      ipcRenderer.invoke('workspace:write-file', filePath, content),
    createFile: (filePath: string, content: string) =>
      ipcRenderer.invoke('workspace:create-file', filePath, content),
    applyEdit: (
      filePath: string,
      oldString: string,
      newString: string,
      replaceAll?: boolean
    ) => ipcRenderer.invoke('workspace:apply-edit', filePath, oldString, newString, replaceAll),
    listDir: (dirPath: string) => ipcRenderer.invoke('workspace:list-dir', dirPath),
    deleteFile: (filePath: string) => ipcRenderer.invoke('workspace:delete-file', filePath),
  },

  // ── Agent (tool-using loop — local Ollama or any cloud provider) ──────
  agent: {
    chat: (params: {
      model: string;
      messages: { role: 'user' | 'assistant' | 'system'; content: string }[];
      system?: string;
      workspaceRoot: string | null;
      requestId: string;
      /** 'ollama' (default) | 'anthropic' | 'openrouter' | 'groq' | ... */
      provider?: string;
    }) => ipcRenderer.invoke('agent:chat', params),
    abort: (requestId: string) => ipcRenderer.invoke('agent:abort', requestId),
    onEvent: (
      cb: (data: {
        requestId: string;
        kind: 'text' | 'tool_call' | 'tool_result' | 'done';
        chunk?: string;
        tool?: string;
        args?: Record<string, string>;
        ok?: boolean;
        summary?: string;
        error?: string;
        done?: boolean;
        aborted?: boolean;
        status?: string;
      }) => void
    ) => {
      const handler = (_: any, data: any) => cb(data);
      ipcRenderer.on('agent:chunk', handler);
      return () => ipcRenderer.removeListener('agent:chunk', handler);
    },
  },

  // ── Ollama ───────────────────────────────────────────────
  ollama: {
    health: () => ipcRenderer.invoke('ollama:health'),
    list: () => ipcRenderer.invoke('ollama:list'),
    pull: (model: string) => ipcRenderer.invoke('ollama:pull', model),
    testModel: (model: string) => ipcRenderer.invoke('ollama:test-model', model),
    chat: (params: { model: string; messages: any[]; system?: string; requestId: string }) =>
      ipcRenderer.invoke('ollama:chat', params),
    abort: (requestId: string) => ipcRenderer.invoke('ollama:abort', requestId),
    unload: (model: string) => ipcRenderer.invoke('ollama:unload', model),
    ensureRunning: (): Promise<{
      ok: boolean;
      alreadyRunning?: boolean;
      spawned?: boolean;
      waitedMs?: number;
      command?: string;
      error?: string;
    }> => ipcRenderer.invoke('ollama:ensure-running'),
    onAutoStart: (cb: (data: any) => void) => {
      const handler = (_: any, data: any) => cb(data);
      ipcRenderer.on('ollama:auto-start', handler);
      return () => ipcRenderer.removeListener('ollama:auto-start', handler);
    },
    onChunk: (cb: (data: { requestId: string; chunk: string; done: boolean }) => void) => {
      const handler = (_: any, data: any) => cb(data);
      ipcRenderer.on('ollama:chunk', handler);
      return () => ipcRenderer.removeListener('ollama:chunk', handler);
    },
    onPullProgress: (cb: (data: { model: string; status: string; percent?: number }) => void) => {
      const handler = (_: any, data: any) => cb(data);
      ipcRenderer.on('ollama:pull-progress', handler);
      return () => ipcRenderer.removeListener('ollama:pull-progress', handler);
    },
  },

  // ── Anthropic / Claude API ───────────────────────────────
  anthropic: {
    hasKey: () => ipcRenderer.invoke('anthropic:has-key'),
    setKey: (key: string) => ipcRenderer.invoke('anthropic:set-key', key),
    clearKey: () => ipcRenderer.invoke('anthropic:clear-key'),
    testKey: () => ipcRenderer.invoke('anthropic:test-key'),
    chat: (params: {
      model?: string;
      messages: any[];
      system?: string;
      requestId: string;
      adaptiveThinking?: boolean;
      effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    }) => ipcRenderer.invoke('anthropic:chat', params),
    onChunk: (cb: (data: { requestId: string; chunk: string; type: string; done: boolean }) => void) => {
      const handler = (_: any, data: any) => cb(data);
      ipcRenderer.on('anthropic:chunk', handler);
      return () => ipcRenderer.removeListener('anthropic:chunk', handler);
    },
  },

  // ── Cloud providers (unified: OpenRouter/Groq/NVIDIA/OpenAI/Gemini/xAI/
  //     Moonshot/DeepSeek/Qwen/Anthropic/custom) ───────────────
  providers: {
    status: (): Promise<
      {
        id: string;
        label: string;
        kind: 'openai' | 'anthropic';
        keyHint: string;
        keysUrl: string;
        baseUrl: string;
        hasKey: boolean;
        modelCount: number;
      }[]
    > => ipcRenderer.invoke('providers:status'),
    setKey: (
      providerId: string,
      key: string
    ): Promise<{ ok: boolean; error?: string; models?: { id: string; displayName: string; provider: string }[] }> =>
      ipcRenderer.invoke('providers:set-key', providerId, key),
    clearKey: (providerId: string) => ipcRenderer.invoke('providers:clear-key', providerId),
    refreshModels: (
      providerId: string
    ): Promise<{ ok: boolean; error?: string; models?: { id: string; displayName: string; provider: string }[] }> =>
      ipcRenderer.invoke('providers:refresh-models', providerId),
    allModels: (): Promise<{ id: string; displayName: string; provider: string }[]> =>
      ipcRenderer.invoke('providers:all-models'),
    setBaseUrl: (providerId: string, url: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('providers:set-base-url', providerId, url),
    chat: (params: {
      providerId: string;
      model: string;
      messages: any[];
      system?: string;
      requestId: string;
      maxTokens?: number;
      temperature?: number;
    }) => ipcRenderer.invoke('providers:chat', params),
    abort: (requestId: string) => ipcRenderer.invoke('providers:abort', requestId),
    onChunk: (
      cb: (data: { requestId: string; chunk: string; type: string; done: boolean; error?: string }) => void
    ) => {
      const handler = (_: any, data: any) => cb(data);
      ipcRenderer.on('providers:chunk', handler);
      return () => ipcRenderer.removeListener('providers:chunk', handler);
    },
  },

  // ── Auto-update (GitHub Releases) ────────────────────────
  updater: {
    state: (): Promise<{
      status: string;
      version?: string;
      notes?: string;
      percent?: number;
      error?: string;
      currentVersion: string;
    }> => ipcRenderer.invoke('updater:state'),
    check: () => ipcRenderer.invoke('updater:check'),
    download: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('updater:download'),
    install: () => ipcRenderer.invoke('updater:install'),
    onEvent: (
      cb: (data: {
        status: string;
        version?: string;
        notes?: string;
        percent?: number;
        error?: string;
        currentVersion: string;
      }) => void
    ) => {
      const handler = (_: any, data: any) => cb(data);
      ipcRenderer.on('updater:event', handler);
      return () => ipcRenderer.removeListener('updater:event', handler);
    },
  },

  // ── MCP servers ──────────────────────────────────────────
  mcp: {
    status: (): Promise<
      { name: string; command: string; enabled: boolean; state: string; error?: string; toolCount: number }[]
    > => ipcRenderer.invoke('mcp:status'),
    sync: (): Promise<
      { name: string; command: string; enabled: boolean; state: string; error?: string; toolCount: number }[]
    > => ipcRenderer.invoke('mcp:sync'),
    listTools: (): Promise<{ server: string; name: string; description: string }[]> =>
      ipcRenderer.invoke('mcp:list-tools'),
  },

  // ── Stable Diffusion (AUTOMATIC1111) ─────────────────────
  sd: {
    health: () => ipcRenderer.invoke('sd:health'),
    ensureRunning: (): Promise<{
      ok: boolean;
      alreadyRunning?: boolean;
      spawned?: boolean;
      webuiPath?: string;
      command?: string;
      patchedApi?: boolean;
      error?: string;
    }> => ipcRenderer.invoke('sd:ensure-running'),
    listModels: () => ipcRenderer.invoke('sd:list-models'),
    setModel: (title: string) => ipcRenderer.invoke('sd:set-model', title),
    txt2img: (params: {
      prompt: string;
      negative_prompt?: string;
      width?: number;
      height?: number;
      steps?: number;
      sampler?: string;
      seed?: number;
    }) => ipcRenderer.invoke('sd:txt2img', params),
    saveImage: (base64: string, savePath: string) =>
      ipcRenderer.invoke('sd:save-image', base64, savePath),
  },

  // ── Multyplan ────────────────────────────────────────────
  multyplan: {
    getConfig: () => ipcRenderer.invoke('multyplan:get-config'),
    setConfig: (patch: {
      maxDebateRounds?: number;
      requireUserApproval?: boolean;
      sequentialExecutionOnly?: boolean;
      models?: { planner?: string; critic?: string; executor?: string };
    }) => ipcRenderer.invoke('multyplan:set-config', patch),
    start: (params: {
      brief: string;
      workspaceRoot: string;
      requestId: string;
      config: {
        maxDebateRounds: number;
        requireUserApproval: boolean;
        sequentialExecutionOnly: boolean;
        models: { planner: string; critic: string; executor: string };
      };
    }) => ipcRenderer.invoke('multyplan:start', params),
    approve: (requestId: string, decision: { approved: boolean; edits?: string }) =>
      ipcRenderer.invoke('multyplan:approve', requestId, decision),
    cancel: (requestId: string) => ipcRenderer.invoke('multyplan:cancel', requestId),
    onProgress: (cb: (data: any) => void) => {
      const handler = (_: any, data: any) => cb(data);
      ipcRenderer.on('multyplan:progress', handler);
      return () => ipcRenderer.removeListener('multyplan:progress', handler);
    },
  },

  // ── Ultrathink ───────────────────────────────────────────
  ultrathink: {
    getConfig: () => ipcRenderer.invoke('ultrathink:get-config'),
    setConfig: (patch: any) => ipcRenderer.invoke('ultrathink:set-config', patch),
    start: (params: {
      task: string;
      workspaceRoot: string;
      requestId: string;
      modelChoice: 'auto' | 'deepseek' | 'gemma';
      config: any;
    }) => ipcRenderer.invoke('ultrathink:start', params),
    cancel: (requestId: string) => ipcRenderer.invoke('ultrathink:cancel', requestId),
    onProgress: (cb: (data: any) => void) => {
      const handler = (_: any, data: any) => cb(data);
      ipcRenderer.on('ultrathink:progress', handler);
      return () => ipcRenderer.removeListener('ultrathink:progress', handler);
    },
  },

  opusPlan: {
    run: (params: {
      brief: string;
      workspaceRoot: string;
      localModel: string;
      requestId: string;
    }) => ipcRenderer.invoke('opus-plan:run', params),
    onProgress: (cb: (data: any) => void) => {
      const handler = (_: any, data: any) => cb(data);
      ipcRenderer.on('opus-plan:progress', handler);
      return () => ipcRenderer.removeListener('opus-plan:progress', handler);
    },
  },

  // ── Typed app settings ───────────────────────────────────
  appSettings: {
    get: () => ipcRenderer.invoke('app-settings:get'),
    patch: (patch: any) => ipcRenderer.invoke('app-settings:patch', patch),
    reset: () => ipcRenderer.invoke('app-settings:reset'),
  },

  // ── Global AI control ────────────────────────────────────
  ai: {
    current: () => ipcRenderer.invoke('ai:current'),
    stop: () => ipcRenderer.invoke('ai:stop'),
  },

  // ── Brain graph ──────────────────────────────────────────
  brain: {
    state: () => ipcRenderer.invoke('brain:state'),
    stats: () => ipcRenderer.invoke('brain:stats'),
    listNodes: (filter?: { type?: string; tag?: string; query?: string }) =>
      ipcRenderer.invoke('brain:list-nodes', filter),
    getNode: (id: string) => ipcRenderer.invoke('brain:get-node', id),
    createNode: (input: any) => ipcRenderer.invoke('brain:create-node', input),
    updateNode: (id: string, patch: any) => ipcRenderer.invoke('brain:update-node', id, patch),
    deleteNode: (id: string) => ipcRenderer.invoke('brain:delete-node', id),
    listEdges: () => ipcRenderer.invoke('brain:list-edges'),
    createEdge: (input: any) => ipcRenderer.invoke('brain:create-edge', input),
    deleteEdge: (id: string) => ipcRenderer.invoke('brain:delete-edge', id),
    listSuggestions: (status?: 'pending' | 'accepted' | 'ignored') =>
      ipcRenderer.invoke('brain:list-suggestions', status),
    resolveSuggestion: (id: string, decision: 'accept' | 'ignore', edits?: any) =>
      ipcRenderer.invoke('brain:resolve-suggestion', id, decision, edits),
    clearResolved: () => ipcRenderer.invoke('brain:clear-resolved'),
    proposeFromChat: (input: {
      user: string;
      assistant: string;
      contextFiles?: string[];
      sourceRef?: string;
    }) => ipcRenderer.invoke('brain:propose-from-chat', input),
    search: (query: string, limit?: number) => ipcRenderer.invoke('brain:search', query, limit),
    related: (id: string, limit?: number) => ipcRenderer.invoke('brain:related', id, limit),
    retrieveForPrompt: (prompt: string, limit?: number) =>
      ipcRenderer.invoke('brain:retrieve-for-prompt', prompt, limit),
    forget: (query: string) => ipcRenderer.invoke('brain:forget', query),
    setProject: (root: string | null) => ipcRenderer.invoke('brain:set-project', root),
    activeProject: (): Promise<{ id: string | null; name: string; showAll: boolean }> =>
      ipcRenderer.invoke('brain:active-project'),
    setShowAll: (show: boolean) => ipcRenderer.invoke('brain:set-show-all', show),
    worklog: (root: string | null, limit?: number): Promise<any[]> =>
      ipcRenderer.invoke('brain:worklog', root, limit),
    export: () => ipcRenderer.invoke('brain:export'),
    import: (blob: any, mode?: 'merge' | 'replace') =>
      ipcRenderer.invoke('brain:import', blob, mode),
    onState: (cb: (state: any) => void) => {
      const handler = (_: any, data: any) => cb(data);
      ipcRenderer.on('brain:state', handler);
      return () => ipcRenderer.removeListener('brain:state', handler);
    },
  },

  // ── Terminal execution (opt-in, approval-gated) ─────────
  terminal: {
    run: (params: {
      command: string;
      requestId: string;
      cwd?: string;
      timeoutMs?: number;
    }): Promise<{
      ok: boolean;
      code?: number | null;
      stdout?: string;
      stderr?: string;
      error?: string;
      truncated?: boolean;
      durationMs?: number;
    }> => ipcRenderer.invoke('terminal:run', params),
    respond: (requestId: string, decision: { approved: boolean; reason?: string }) =>
      ipcRenderer.invoke('terminal:respond', requestId, decision),
    abort: (requestId: string) => ipcRenderer.invoke('terminal:abort', requestId),
    onApprovalRequest: (
      cb: (data: { requestId: string; command: string; cwd: string; timeoutMs: number }) => void
    ) => {
      const handler = (_: any, data: any) => cb(data);
      ipcRenderer.on('terminal:approval-request', handler);
      return () => ipcRenderer.removeListener('terminal:approval-request', handler);
    },
  },

  // ── /cdesign skill (bundled cdesign-skill bundle) ────────
  cdesign: {
    getSystemPrompt: (): Promise<string> => ipcRenderer.invoke('cdesign:get-system-prompt'),
    listRecipes: (): Promise<{ name: string; description: string }[]> =>
      ipcRenderer.invoke('cdesign:list-recipes'),
    readRecipe: (name: string): Promise<{ ok: boolean; content?: string; error?: string }> =>
      ipcRenderer.invoke('cdesign:read-recipe', name),
    scaffold: (
      targetDir: string
    ): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('cdesign:scaffold', targetDir),
    paths: (): Promise<{ resources: string; cdesign: string; starterZip: string }> =>
      ipcRenderer.invoke('cdesign:paths'),
  },

  // ── Chat With Model (CWM) — conversational mode ──────────
  // No agent/workspace/terminal access on purpose: sessions + media only.
  cwm: {
    listSessions: (): Promise<
      { id: string; title: string; createdAt: number; updatedAt: number; messageCount: number; model?: string }[]
    > => ipcRenderer.invoke('cwm:list-sessions'),
    getSession: (id: string): Promise<{ ok: boolean; session?: any; error?: string }> =>
      ipcRenderer.invoke('cwm:get-session', id),
    saveSession: (doc: {
      id: string;
      title: string;
      createdAt: number;
      updatedAt: number;
      messageCount: number;
      model?: string;
      messages: unknown[];
    }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('cwm:save-session', doc),
    deleteSession: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('cwm:delete-session', id),
    imageProviders: (): Promise<{ id: string; label: string; model: string; hasKey: boolean }[]> =>
      ipcRenderer.invoke('cwm:image-providers'),
    videoProviders: (): Promise<{ id: string; label: string; model: string; hasKey: boolean }[]> =>
      ipcRenderer.invoke('cwm:video-providers'),
    generateImage: (params: {
      jobId: string;
      providerId: string;
      model?: string;
      prompt: string;
      size?: string;
    }) => ipcRenderer.invoke('cwm:generate-image', params),
    generateVideo: (params: {
      jobId: string;
      providerId: string;
      model?: string;
      prompt: string;
      seconds?: number;
    }) => ipcRenderer.invoke('cwm:generate-video', params),
    cancelMedia: (jobId: string): Promise<boolean> => ipcRenderer.invoke('cwm:cancel-media', jobId),
    saveMediaAs: (filePath: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('cwm:save-media-as', filePath),
    readMedia: (filePath: string): Promise<{ ok: boolean; base64?: string; error?: string }> =>
      ipcRenderer.invoke('cwm:read-media', filePath),
    onMediaProgress: (
      cb: (data: {
        jobId: string;
        kind: 'image' | 'video';
        status: 'queued' | 'generating' | 'done' | 'failed' | 'cancelled';
        percent?: number;
        filePath?: string;
        fileName?: string;
        mediaType?: string;
        base64?: string;
        error?: string;
      }) => void
    ) => {
      const handler = (_: any, data: any) => cb(data);
      ipcRenderer.on('cwm:media-progress', handler);
      return () => ipcRenderer.removeListener('cwm:media-progress', handler);
    },
  },

  // ── Legacy untyped settings ──────────────────────────────
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('settings:set', key, value),
    all: () => ipcRenderer.invoke('settings:all'),
  },

  // ── External ─────────────────────────────────────────────
  openExternal: (url: string) => ipcRenderer.invoke('external:open', url),
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
