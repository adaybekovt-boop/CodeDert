import { afterEach, describe, expect, it } from 'vitest';
import { aiMutex } from '../electron/services/ai-mutex';

function releaseAll() {
  const cur = aiMutex.current();
  if (cur) aiMutex.cancelCurrent();
}

afterEach(releaseAll);

describe('aiMutex', () => {
  it('grants the lock to the first acquirer', () => {
    const r = aiMutex.acquire('agent', 'r1');
    expect(r.ok).toBe(true);
    r.release?.();
  });

  it('rejects a second acquirer with a different requestId', () => {
    const a = aiMutex.acquire('agent', 'r1');
    expect(a.ok).toBe(true);
    const b = aiMutex.acquire('multyplan', 'r2');
    expect(b.ok).toBe(false);
    a.release?.();
  });

  it('treats reacquire with same requestId as no-op success', () => {
    const a = aiMutex.acquire('agent', 'r1');
    const b = aiMutex.acquire('agent', 'r1');
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    a.release?.();
  });

  it('treats child requestIds as part of the current owner', () => {
    const a = aiMutex.acquire('multyplan', 'parent');
    expect(a.ok).toBe(true);
    expect(aiMutex.isHeldBy('parent::executor')).toBe(true);

    const child = aiMutex.acquire('agent', 'parent::executor');
    expect(child.ok).toBe(true);
    child.release?.();

    expect(aiMutex.current()?.requestId).toBe('parent');
    a.release?.();
  });

  it('cancelCurrent invokes the cancel hook but keeps the lock until owner releases', () => {
    let cancelled = false;
    const a = aiMutex.acquire('ultrathink', 'r1', () => {
      cancelled = true;
    });
    expect(a.ok).toBe(true);
    const res = aiMutex.cancelCurrent();
    expect(res.cancelled).toBe(true);
    expect(cancelled).toBe(true);
    expect(aiMutex.current()?.requestId).toBe('r1');

    // The current owner still owns the slot while it aborts/unloads.
    const b = aiMutex.acquire('agent', 'r2');
    expect(b.ok).toBe(false);

    a.release?.();
    const c = aiMutex.acquire('agent', 'r2');
    expect(c.ok).toBe(true);
    c.release?.();
  });
});
