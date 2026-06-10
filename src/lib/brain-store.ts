import { create } from 'zustand';
import type { BrainEdge, BrainNode, BrainState, BrainSuggestion, ScoredBrainNode } from './brain-types';

/**
 * Zustand mirror of the main-process Brain state.
 *
 * Refresh path:
 *   - on first mount we ask `window.api.brain.state()`,
 *   - then subscribe to `brain.onState` push events,
 *   - mutations go through `window.api.brain.*` and the next `brain:state`
 *     push refreshes us automatically.
 *
 * This avoids drift between IPC mutations and the renderer view.
 */

interface BrainStore {
  initialized: boolean;
  nodes: BrainNode[];
  edges: BrainEdge[];
  suggestions: BrainSuggestion[];
  selectedNodeId: string | null;
  /** Last retrieval set — used by the Active Context panel. */
  lastInjection: { at: number; prompt: string; results: ScoredBrainNode[] } | null;
  /** Pinned node ids — included in retrieval results regardless of score. */
  pinnedIds: string[];

  bootstrap: () => Promise<void>;
  applyState: (state: BrainState) => void;
  select: (nodeId: string | null) => void;
  setLastInjection: (prompt: string, results: ScoredBrainNode[]) => void;
  togglePin: (nodeId: string) => void;
}

export const useBrainStore = create<BrainStore>((set, get) => ({
  initialized: false,
  nodes: [],
  edges: [],
  suggestions: [],
  selectedNodeId: null,
  lastInjection: null,
  pinnedIds: [],

  bootstrap: async () => {
    if (get().initialized) return;
    set({ initialized: true });
    try {
      const initial = await window.api.brain.state();
      if (initial) set({ nodes: initial.nodes, edges: initial.edges, suggestions: initial.suggestions });
    } catch (err) {
      console.error('brain bootstrap failed', err);
    }
    window.api.brain.onState((state) => {
      set({ nodes: state.nodes, edges: state.edges, suggestions: state.suggestions });
    });
  },

  applyState: (state) =>
    set({ nodes: state.nodes, edges: state.edges, suggestions: state.suggestions }),

  select: (nodeId) => set({ selectedNodeId: nodeId }),

  setLastInjection: (prompt, results) =>
    set({ lastInjection: { at: Date.now(), prompt, results } }),

  togglePin: (nodeId) =>
    set((s) => ({
      pinnedIds: s.pinnedIds.includes(nodeId)
        ? s.pinnedIds.filter((id) => id !== nodeId)
        : [...s.pinnedIds, nodeId],
    })),
}));
