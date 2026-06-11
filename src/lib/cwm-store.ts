import { create } from 'zustand';
import { genId } from './utils';
import type { CwmAttachment, CwmGenJob, CwmMessage, CwmSessionMeta } from './cwm-types';
import type { ModelChoice } from '../types';

/**
 * Chat With Model — state, isolated from the IDE/agent store on purpose.
 * Sessions persist through window.api.cwm (userData/cwm/sessions), never
 * through agent session storage or the workspace.
 */
interface CwmState {
  sessions: CwmSessionMeta[];
  activeSessionId: string | null;
  /** createdAt of the active session (kept for re-save). */
  activeCreatedAt: number;
  title: string;
  messages: CwmMessage[];
  isStreaming: boolean;
  selectedModel: ModelChoice | null;
  pendingAttachments: CwmAttachment[];
  bootstrapped: boolean;

  bootstrap: (models: ModelChoice[]) => Promise<void>;
  refreshSessions: () => Promise<void>;
  newSession: () => void;
  openSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  persist: () => Promise<void>;

  setModel: (m: ModelChoice) => void;
  addMessage: (msg: CwmMessage) => void;
  appendToMessage: (id: string, chunk: string, field?: 'content' | 'thinking') => void;
  finishMessage: (id: string, error?: string) => void;
  updateGenJob: (jobId: string, patch: Partial<CwmGenJob>) => void;
  setStreaming: (s: boolean) => void;

  addAttachments: (atts: CwmAttachment[]) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
}

const HARD_CAP = 400;

function deriveTitle(messages: CwmMessage[]): string {
  const first = messages.find((m) => m.role === 'user' && m.content.trim());
  if (!first) return 'Новый чат';
  return first.content.trim().replace(/\s+/g, ' ').slice(0, 60);
}

export const useCwmStore = create<CwmState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  activeCreatedAt: Date.now(),
  title: 'Новый чат',
  messages: [],
  isStreaming: false,
  selectedModel: null,
  pendingAttachments: [],
  bootstrapped: false,

  bootstrap: async (models) => {
    if (get().bootstrapped) {
      // Re-resolve the model in case the available list changed.
      const cur = get().selectedModel;
      if (cur && !models.find((m) => m.id === cur.id)) {
        set({ selectedModel: models[0] || null });
      }
      return;
    }
    set({ bootstrapped: true });
    try {
      const savedId = (await window.api.settings.get('cwmSelectedModelId')) as string | undefined;
      const saved = models.find((m) => m.id === savedId);
      set({ selectedModel: saved || models[0] || null });
    } catch {
      set({ selectedModel: models[0] || null });
    }
    await get().refreshSessions();
  },

  refreshSessions: async () => {
    try {
      const sessions = await window.api.cwm.listSessions();
      set({ sessions });
    } catch {
      /* list stays as-is */
    }
  },

  newSession: () => {
    set({
      activeSessionId: null,
      activeCreatedAt: Date.now(),
      title: 'Новый чат',
      messages: [],
      pendingAttachments: [],
      isStreaming: false,
    });
  },

  openSession: async (id) => {
    const res = await window.api.cwm.getSession(id);
    if (!res.ok || !res.session) return;
    set({
      activeSessionId: id,
      activeCreatedAt: res.session.createdAt || Date.now(),
      title: res.session.title || 'Без названия',
      messages: (res.session.messages as CwmMessage[]).map((m) => ({ ...m, streaming: false })),
      pendingAttachments: [],
      isStreaming: false,
    });
  },

  deleteSession: async (id) => {
    await window.api.cwm.deleteSession(id);
    if (get().activeSessionId === id) get().newSession();
    await get().refreshSessions();
  },

  persist: async () => {
    const s = get();
    if (s.messages.length === 0) return;
    const id = s.activeSessionId || genId();
    const title = deriveTitle(s.messages);
    if (!s.activeSessionId) set({ activeSessionId: id });
    set({ title });
    const res = await window.api.cwm.saveSession({
      id,
      title,
      createdAt: s.activeCreatedAt,
      updatedAt: Date.now(),
      messageCount: s.messages.length,
      model: s.selectedModel?.displayName,
      messages: s.messages.map((m) => ({ ...m, streaming: false })),
    });
    if (!res.ok) console.warn('cwm session save failed:', res.error);
    await get().refreshSessions();
  },

  setModel: (m) => {
    set({ selectedModel: m });
    window.api.settings.set('cwmSelectedModelId', m.id).catch(() => {});
  },

  addMessage: (msg) =>
    set((s) => {
      const next = [...s.messages, msg];
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
      messages: s.messages.map((m) => (m.id === id ? { ...m, streaming: false, error } : m)),
    })),

  updateGenJob: (jobId, patch) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.gen?.jobId === jobId ? { ...m, gen: { ...m.gen, ...patch } } : m
      ),
    })),

  setStreaming: (v) => set({ isStreaming: v }),

  addAttachments: (atts) =>
    set((s) => ({ pendingAttachments: [...s.pendingAttachments, ...atts] })),

  removeAttachment: (id) =>
    set((s) => ({ pendingAttachments: s.pendingAttachments.filter((a) => a.id !== id) })),

  clearAttachments: () => set({ pendingAttachments: [] }),
}));
