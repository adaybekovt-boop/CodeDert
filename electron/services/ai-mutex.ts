/**
 * Global mutex coordinating any long-running local-model workflow.
 *
 * Only ONE owner can hold the lock at a time. Used by /multyplan, /ultrathink,
 * /plan (opus-plan), and the file-tool `agent` loop to guarantee:
 *   - no two heavy local models are co-resident,
 *   - cancellation always reaches the right backend,
 *   - the UI sees a single in-flight task at a time.
 *
 * Owners are identified by a stable requestId. acquire() returns either an
 * AcquireToken or a structured error if the lock is taken.
 */

export type AiTaskKind =
  | 'agent'
  | 'multyplan'
  | 'ultrathink'
  | 'opus-plan'
  | 'ollama-chat'
  | 'providers-chat';

export interface AiLockHolder {
  requestId: string;
  kind: AiTaskKind;
  startedAt: number;
  /** Optional cooperative-cancellation hook the holder registers. */
  cancel?: () => void;
}

export interface AcquireResult {
  ok: boolean;
  error?: string;
  /** Set only when ok=true. Call to release the lock. */
  release?: () => void;
  /** Set only when ok=true. Replace the cancel hook later (after token returned). */
  setCancel?: (fn: () => void) => void;
}

let current: AiLockHolder | null = null;

export const aiMutex = {
  acquire(kind: AiTaskKind, requestId: string, cancel?: () => void): AcquireResult {
    if (current && current.requestId !== requestId && !isChildRequest(current.requestId, requestId)) {
      return {
        ok: false,
        error: `another AI task is running (${current.kind}). Cancel it first or wait.`,
      };
    }
    if (current && (current.requestId === requestId || isChildRequest(current.requestId, requestId))) {
      return {
        ok: true,
        release: () => {},
        setCancel: () => {},
      };
    }
    current = { requestId, kind, startedAt: Date.now(), cancel };
    const release = () => {
      if (current && current.requestId === requestId) current = null;
    };
    const setCancel = (fn: () => void) => {
      if (current && current.requestId === requestId) current.cancel = fn;
    };
    return { ok: true, release, setCancel };
  },

  /**
   * Cancel whoever currently holds the lock, if anyone. Used by the global
   * /stop command from the UI.
   */
  cancelCurrent(): { cancelled: boolean; kind?: AiTaskKind; requestId?: string } {
    if (!current) return { cancelled: false };
    const { kind, requestId, cancel } = current;
    try {
      cancel?.();
    } catch {
      /* swallow */
    }
    return { cancelled: true, kind, requestId };
  },

  current(): AiLockHolder | null {
    return current;
  },

  isHeldBy(requestId: string): boolean {
    return !!current && (current.requestId === requestId || isChildRequest(current.requestId, requestId));
  },
};

function isChildRequest(parentRequestId: string, requestId: string): boolean {
  return requestId.startsWith(`${parentRequestId}::`);
}
