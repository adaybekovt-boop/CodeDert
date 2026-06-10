/**
 * Lightweight per-requestId subscription bus for ollama streaming chunks.
 *
 * Why this exists: the old multyplan/ultrathink/opus-plan code monkey-patched
 * `win.webContents.send` to intercept Ollama chunks. That breaks when two
 * orchestrators try to run at once (we now serialize via aiMutex, but the
 * monkey-patch is still fragile if any other channel fires while installed).
 *
 * The new model: `ollama.chat` continues to send 'ollama:chunk' to the
 * renderer for the chat path, but ALSO dispatches to in-process subscribers
 * registered here. Orchestrators subscribe by requestId, get callbacks, and
 * unsubscribe in a finally block.
 */

export interface OllamaChunkEvent {
  requestId: string;
  chunk: string;
  done: boolean;
  error?: string;
  aborted?: boolean;
}

type Listener = (ev: OllamaChunkEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export const ollamaBus = {
  subscribe(requestId: string, fn: Listener): () => void {
    let set = listeners.get(requestId);
    if (!set) {
      set = new Set();
      listeners.set(requestId, set);
    }
    set.add(fn);
    return () => {
      const s = listeners.get(requestId);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) listeners.delete(requestId);
    };
  },

  emit(ev: OllamaChunkEvent): void {
    const set = listeners.get(ev.requestId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(ev);
      } catch {
        /* never let one bad listener break the rest */
      }
    }
  },
};
