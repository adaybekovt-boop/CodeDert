import { describe, expect, it } from 'vitest';
import { retrieve, scoreNode, tokenize } from '../electron/services/brain-retrieval';

function n(
  id: string,
  title: string,
  summary = '',
  content = '',
  tags: string[] = [],
  type = 'memory',
  importance = 0.5,
  confidence = 0.9
) {
  return { id, title, summary, content, tags, type, importance, confidence };
}

const NODES = [
  n('a', 'Sequential local model execution rule', 'Run heavy local models one at a time', '', ['vram', 'rule'], 'workflow', 0.8),
  n('b', 'Qwen3-Coder is the multyplan executor', 'It writes code after the plan is approved', '', ['multyplan', 'executor'], 'decision', 0.7),
  n('c', 'CDesign starter uses Next 15 + Motion + GSAP', '', '', ['cdesign', 'frontend'], 'architecture', 0.5),
  n('d', 'Bug: file tree freezes on large repos', 'Workspace scan blocks the event loop', '', ['bug', 'perf'], 'bug', 0.7),
  n('e', 'Random unrelated memory about coffee', '', '', ['misc'], 'memory', 0.1),
];
const EDGES = [
  { fromNodeId: 'a', toNodeId: 'b', type: 'used_in' },
  { fromNodeId: 'b', toNodeId: 'c', type: 'related' },
];

describe('tokenize', () => {
  it('drops stopwords and short tokens', () => {
    const t = tokenize('the workspace uses Zustand and electron-store for state');
    expect(t).toContain('workspace');
    expect(t).toContain('zustand');
    expect(t).not.toContain('the');
    expect(t).not.toContain('and');
  });
});

describe('scoreNode', () => {
  it('scores higher when tags match the query', () => {
    const queryTokens = tokenize('multyplan executor question');
    const matching = scoreNode(NODES.find((x) => x.id === 'b')!, queryTokens);
    const unrelated = scoreNode(NODES.find((x) => x.id === 'e')!, queryTokens);
    expect(matching).toBeGreaterThan(unrelated);
  });

  it('returns 0 when nothing matches', () => {
    expect(scoreNode(NODES.find((x) => x.id === 'e')!, ['firmware', 'kernel'])).toBe(0);
  });
});

describe('retrieve', () => {
  it('returns the most relevant nodes for a multyplan query', () => {
    const out = retrieve(NODES, EDGES, 'how does multyplan executor work', { limit: 3 });
    const ids = out.map((s) => s.node.id);
    expect(ids).toContain('b');
    expect(ids).not.toContain('e');
  });

  it('expands one hop to neighbors when there is budget', () => {
    const out = retrieve(NODES, EDGES, 'sequential local model rule', { limit: 4, expandNeighbors: true });
    const ids = out.map((s) => s.node.id);
    expect(ids).toContain('a');
    // 'b' is a neighbor of 'a' via "used_in"
    expect(ids).toContain('b');
  });

  it('respects type filter', () => {
    const out = retrieve(NODES, EDGES, 'bug freeze', { limit: 5, types: ['bug'] });
    expect(out.every((s) => s.node.type === 'bug')).toBe(true);
  });

  it('places pinned nodes first regardless of score', () => {
    const out = retrieve(NODES, EDGES, 'multyplan', { limit: 5, pinnedIds: ['e'] });
    expect(out[0].node.id).toBe('e');
    expect(out[0].via).toBe('pinned');
  });
});
