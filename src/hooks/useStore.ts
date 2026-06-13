import { create } from 'zustand';
import type { ChatMessage, ChatMode, FileNode, ModelChoice, OpenFile, ToolEvent } from '../types';

export interface ProjectMapNode {
  id: string;
  name: string;
  relPath: string;
  kind: 'file' | 'folder';
  parentId: string | null;
  preview?: string;
  language?: string;
  childCount?: number;
  /** How many real children the scanner cut by a limit (shown as "+N скрыто"). */
  hiddenChildren?: number;
}

export interface ProjectMapGraph {
  nodes: ProjectMapNode[];
  edges: { from: string; to: string }[];
  rootName: string;
  /** True when any scan limit truncated the graph. */
  truncated?: boolean;
}

interface AppState {
  // Workspace
  workspaceRoot: string | null;
  fileTree: FileNode | null;
  projectMap: string | null;
  projectMapGraph: ProjectMapGraph | null;
  projectMapLoading: boolean;
  openFiles: OpenFile[];
  activeFilePath: string | null;

  // Model selection
  selectedModel: ModelChoice | null;
  availableModels: ModelChoice[];
  chatMode: ChatMode;
  hasAnthropicKey: boolean;

  // Sidebar
  activePanel: 'files' | 'chat' | 'image' | 'settings' | 'brain' | 'cwm' | 'map';

  // Chat
  messages: ChatMessage[];
  isStreaming: boolean;

  // Onboarding
  needsOnboarding: boolean;

  // Actions
  setWorkspace: (root: string, tree: FileNode) => void;
  refreshFileTree: () => Promise<void>;
  refreshProjectMap: () => Promise<void>;
  openFile: (path: string) => Promise<void>;
  closeFile: (path: string) => void;
  updateFileContent: (path: string, content: string) => void;
  saveFile: (path: string) => Promise<void>;
  setActiveFile: (path: string | null) => void;

  setModel: (model: ModelChoice) => void;
  setAvailableModels: (models: ModelChoice[]) => void;
  setChatMode: (mode: ChatMode) => void;
  setHasAnthropicKey: (has: boolean) => void;

  setActivePanel: (panel: 'files' | 'chat' | 'image' | 'settings' | 'brain' | 'cwm' | 'map') => void;

  addMessage: (msg: ChatMessage) => void;
  appendToMessage: (id: string, chunk: string, field?: 'content' | 'thinking') => void;
  finishMessage: (id: string, error?: string) => void;
  addToolEvent: (msgId: string, event: ToolEvent) => void;
  updateToolEvent: (msgId: string, eventId: string, patch: Partial<ToolEvent>) => void;
  updateMessage: (id: string, patch: Partial<ChatMessage>) => void;
  clearChat: () => void;
  setStreaming: (s: boolean) => void;

  setNeedsOnboarding: (n: boolean) => void;
}

function languageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    cs: 'csharp', cpp: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
    html: 'html', css: 'css', scss: 'scss', less: 'less',
    json: 'json', xml: 'xml', yaml: 'yaml', yml: 'yaml',
    md: 'markdown', sh: 'shell', bash: 'shell', zsh: 'shell',
    sql: 'sql', php: 'php', swift: 'swift', kt: 'kotlin',
    vue: 'html', svelte: 'html',
  };
  return map[ext || ''] || 'plaintext';
}

export const useStore = create<AppState>((set, get) => ({
  workspaceRoot: null,
  fileTree: null,
  projectMap: null,
  projectMapGraph: null,
  projectMapLoading: false,
  openFiles: [],
  activeFilePath: null,

  selectedModel: null,
  availableModels: [],
  chatMode: 'code',
  hasAnthropicKey: false,

  activePanel: 'files',

  messages: [],
  isStreaming: false,

  needsOnboarding: true,

  setWorkspace: (root, tree) => {
    set({
      workspaceRoot: root,
      fileTree: tree,
      projectMap: null,
      projectMapGraph: null,
      projectMapLoading: true,
      openFiles: [],
      activeFilePath: null,
    });
    // Tell main process and persist for next boot.
    window.api.workspace.setRoot(root).catch(() => {});
    window.api.settings.set('lastWorkspaceRoot', root).catch(() => {});
    // Scope the Brain (notes + worklog) to this project.
    window.api.brain.setProject(root).catch(() => {});
    // Generate project map in the background (AI text + viz graph).
    window.api.workspace.projectMap(root).then((map) => {
      set({
        projectMap: map?.text || null,
        projectMapGraph: map?.graph || null,
        projectMapLoading: false,
      });
    }).catch(() => {
      set({ projectMapLoading: false });
    });
  },

  refreshFileTree: async () => {
    const { workspaceRoot } = get();
    if (!workspaceRoot) return;
    const tree = await window.api.workspace.listFiles(workspaceRoot);
    set({ fileTree: tree });
  },

  refreshProjectMap: async () => {
    const { workspaceRoot } = get();
    if (!workspaceRoot) return;
    set({ projectMapLoading: true });
    try {
      const map = await window.api.workspace.projectMap(workspaceRoot);
      set({
        projectMap: map?.text || null,
        projectMapGraph: map?.graph || null,
        projectMapLoading: false,
      });
    } catch {
      set({ projectMapLoading: false });
    }
  },

  openFile: async (path) => {
    const { openFiles } = get();
    if (openFiles.find((f) => f.path === path)) {
      set({ activeFilePath: path });
      return;
    }
    const res = await window.api.workspace.readFile(path);
    if (!res.ok) {
      console.error('readFile failed:', res.error);
      return;
    }
    const name = path.split(/[\\/]/).pop() || path;
    const newFile: OpenFile = {
      path,
      name,
      content: res.content || '',
      dirty: false,
      language: languageFromPath(path),
    };
    set({ openFiles: [...openFiles, newFile], activeFilePath: path });
  },

  closeFile: (path) => {
    const { openFiles, activeFilePath } = get();
    const filtered = openFiles.filter((f) => f.path !== path);
    let newActive: string | null = activeFilePath;
    if (activeFilePath === path) {
      newActive = filtered.length > 0 ? filtered[filtered.length - 1].path : null;
    }
    set({ openFiles: filtered, activeFilePath: newActive });
  },

  updateFileContent: (path, content) => {
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.path === path ? { ...f, content, dirty: true } : f
      ),
    }));
  },

  saveFile: async (path) => {
    const file = get().openFiles.find((f) => f.path === path);
    if (!file) return;
    const res = await window.api.workspace.writeFile(path, file.content);
    if (res.ok) {
      set((s) => ({
        openFiles: s.openFiles.map((f) =>
          f.path === path ? { ...f, dirty: false } : f
        ),
      }));
    }
  },

  setActiveFile: (path) => set({ activeFilePath: path }),

  setModel: (model) => set({ selectedModel: model }),
  setAvailableModels: (models) => set({ availableModels: models }),
  setChatMode: (mode) => set({ chatMode: mode }),
  setHasAnthropicKey: (has) => set({ hasAnthropicKey: has }),

  setActivePanel: (panel) => set({ activePanel: panel }),

  addMessage: (msg) =>
    set((s) => {
      const next = [...s.messages, msg];
      // Cap history aggressively to avoid unbounded memory growth.
      const HARD_CAP = 500;
      return { messages: next.length > HARD_CAP ? next.slice(next.length - HARD_CAP) : next };
    }),

  appendToMessage: (id, chunk, field = 'content') =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === id
          ? field === 'thinking'
            ? { ...m, thinking: (m.thinking || '') + chunk }
            : { ...m, content: m.content + chunk }
          : m
      ),
    })),

  finishMessage: (id, error) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === id ? { ...m, streaming: false, error } : m
      ),
    })),

  addToolEvent: (msgId, event) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === msgId ? { ...m, toolEvents: [...(m.toolEvents || []), event] } : m
      ),
    })),

  updateToolEvent: (msgId, eventId, patch) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === msgId
          ? {
              ...m,
              toolEvents: (m.toolEvents || []).map((ev) =>
                ev.id === eventId ? { ...ev, ...patch } : ev
              ),
            }
          : m
      ),
    })),

  updateMessage: (id, patch) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    })),

  clearChat: () => set({ messages: [] }),

  setStreaming: (s) => set({ isStreaming: s }),

  setNeedsOnboarding: (n) => set({ needsOnboarding: n }),
}));
