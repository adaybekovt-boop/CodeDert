const { contextBridge, ipcRenderer } = require('electron');

const api = {
  hardware: {
    probe: () => ipcRenderer.invoke('hardware:probe'),
    recommendModels: () => ipcRenderer.invoke('hardware:recommend-models'),
  },

  workspace: {
    openFolder: () => ipcRenderer.invoke('workspace:open-folder'),
    setRoot: (root) => ipcRenderer.invoke('workspace:set-root', root),
    listFiles: (root) => ipcRenderer.invoke('workspace:list-files', root),
    readFile: (filePath) => ipcRenderer.invoke('workspace:read-file', filePath),
    writeFile: (filePath, content) => ipcRenderer.invoke('workspace:write-file', filePath, content),
    createFile: (filePath, content) => ipcRenderer.invoke('workspace:create-file', filePath, content),
    applyEdit: (filePath, oldString, newString, replaceAll) =>
      ipcRenderer.invoke('workspace:apply-edit', filePath, oldString, newString, replaceAll),
    listDir: (dirPath) => ipcRenderer.invoke('workspace:list-dir', dirPath),
    deleteFile: (filePath) => ipcRenderer.invoke('workspace:delete-file', filePath),
  },

  agent: {
    chat: (params) => ipcRenderer.invoke('agent:chat', params),
    abort: (requestId) => ipcRenderer.invoke('agent:abort', requestId),
    onEvent: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('agent:chunk', handler);
      return () => ipcRenderer.removeListener('agent:chunk', handler);
    },
  },

  ollama: {
    health: () => ipcRenderer.invoke('ollama:health'),
    list: () => ipcRenderer.invoke('ollama:list'),
    pull: (model) => ipcRenderer.invoke('ollama:pull', model),
    testModel: (model) => ipcRenderer.invoke('ollama:test-model', model),
    chat: (params) => ipcRenderer.invoke('ollama:chat', params),
    abort: (requestId) => ipcRenderer.invoke('ollama:abort', requestId),
    unload: (model) => ipcRenderer.invoke('ollama:unload', model),
    ensureRunning: () => ipcRenderer.invoke('ollama:ensure-running'),
    onAutoStart: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('ollama:auto-start', handler);
      return () => ipcRenderer.removeListener('ollama:auto-start', handler);
    },
    onChunk: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('ollama:chunk', handler);
      return () => ipcRenderer.removeListener('ollama:chunk', handler);
    },
    onPullProgress: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('ollama:pull-progress', handler);
      return () => ipcRenderer.removeListener('ollama:pull-progress', handler);
    },
  },

  anthropic: {
    hasKey: () => ipcRenderer.invoke('anthropic:has-key'),
    setKey: (key) => ipcRenderer.invoke('anthropic:set-key', key),
    clearKey: () => ipcRenderer.invoke('anthropic:clear-key'),
    testKey: () => ipcRenderer.invoke('anthropic:test-key'),
    chat: (params) => ipcRenderer.invoke('anthropic:chat', params),
    onChunk: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('anthropic:chunk', handler);
      return () => ipcRenderer.removeListener('anthropic:chunk', handler);
    },
  },

  sd: {
    health: () => ipcRenderer.invoke('sd:health'),
    listModels: () => ipcRenderer.invoke('sd:list-models'),
    setModel: (title) => ipcRenderer.invoke('sd:set-model', title),
    txt2img: (params) => ipcRenderer.invoke('sd:txt2img', params),
    saveImage: (base64, savePath) => ipcRenderer.invoke('sd:save-image', base64, savePath),
  },

  opusPlan: {
    run: (params) => ipcRenderer.invoke('opus-plan:run', params),
    onProgress: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('opus-plan:progress', handler);
      return () => ipcRenderer.removeListener('opus-plan:progress', handler);
    },
  },

  multyplan: {
    getConfig: () => ipcRenderer.invoke('multyplan:get-config'),
    setConfig: (patch) => ipcRenderer.invoke('multyplan:set-config', patch),
    start: (params) => ipcRenderer.invoke('multyplan:start', params),
    approve: (requestId, decision) =>
      ipcRenderer.invoke('multyplan:approve', requestId, decision),
    cancel: (requestId) => ipcRenderer.invoke('multyplan:cancel', requestId),
    onProgress: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('multyplan:progress', handler);
      return () => ipcRenderer.removeListener('multyplan:progress', handler);
    },
  },

  ultrathink: {
    getConfig: () => ipcRenderer.invoke('ultrathink:get-config'),
    setConfig: (patch) => ipcRenderer.invoke('ultrathink:set-config', patch),
    start: (params) => ipcRenderer.invoke('ultrathink:start', params),
    cancel: (requestId) => ipcRenderer.invoke('ultrathink:cancel', requestId),
    onProgress: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('ultrathink:progress', handler);
      return () => ipcRenderer.removeListener('ultrathink:progress', handler);
    },
  },

  appSettings: {
    get: () => ipcRenderer.invoke('app-settings:get'),
    patch: (patch) => ipcRenderer.invoke('app-settings:patch', patch),
    reset: () => ipcRenderer.invoke('app-settings:reset'),
  },

  ai: {
    current: () => ipcRenderer.invoke('ai:current'),
    stop: () => ipcRenderer.invoke('ai:stop'),
  },

  brain: {
    state: () => ipcRenderer.invoke('brain:state'),
    stats: () => ipcRenderer.invoke('brain:stats'),
    listNodes: (filter) => ipcRenderer.invoke('brain:list-nodes', filter),
    getNode: (id) => ipcRenderer.invoke('brain:get-node', id),
    createNode: (input) => ipcRenderer.invoke('brain:create-node', input),
    updateNode: (id, patch) => ipcRenderer.invoke('brain:update-node', id, patch),
    deleteNode: (id) => ipcRenderer.invoke('brain:delete-node', id),
    listEdges: () => ipcRenderer.invoke('brain:list-edges'),
    createEdge: (input) => ipcRenderer.invoke('brain:create-edge', input),
    deleteEdge: (id) => ipcRenderer.invoke('brain:delete-edge', id),
    listSuggestions: (status) => ipcRenderer.invoke('brain:list-suggestions', status),
    resolveSuggestion: (id, decision, edits) =>
      ipcRenderer.invoke('brain:resolve-suggestion', id, decision, edits),
    clearResolved: () => ipcRenderer.invoke('brain:clear-resolved'),
    proposeFromChat: (input) => ipcRenderer.invoke('brain:propose-from-chat', input),
    search: (query, limit) => ipcRenderer.invoke('brain:search', query, limit),
    related: (id, limit) => ipcRenderer.invoke('brain:related', id, limit),
    retrieveForPrompt: (prompt, limit) =>
      ipcRenderer.invoke('brain:retrieve-for-prompt', prompt, limit),
    forget: (query) => ipcRenderer.invoke('brain:forget', query),
    export: () => ipcRenderer.invoke('brain:export'),
    import: (blob, mode) => ipcRenderer.invoke('brain:import', blob, mode),
    onState: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('brain:state', handler);
      return () => ipcRenderer.removeListener('brain:state', handler);
    },
  },

  terminal: {
    run: (params) => ipcRenderer.invoke('terminal:run', params),
    respond: (requestId, decision) => ipcRenderer.invoke('terminal:respond', requestId, decision),
    abort: (requestId) => ipcRenderer.invoke('terminal:abort', requestId),
    onApprovalRequest: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('terminal:approval-request', handler);
      return () => ipcRenderer.removeListener('terminal:approval-request', handler);
    },
  },

  cdesign: {
    getSystemPrompt: () => ipcRenderer.invoke('cdesign:get-system-prompt'),
    listRecipes: () => ipcRenderer.invoke('cdesign:list-recipes'),
    readRecipe: (name) => ipcRenderer.invoke('cdesign:read-recipe', name),
    scaffold: (targetDir) => ipcRenderer.invoke('cdesign:scaffold', targetDir),
    paths: () => ipcRenderer.invoke('cdesign:paths'),
  },

  settings: {
    get: (key) => ipcRenderer.invoke('settings:get', key),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
    all: () => ipcRenderer.invoke('settings:all'),
  },

  openExternal: (url) => ipcRenderer.invoke('external:open', url),
};

contextBridge.exposeInMainWorld('api', api);
