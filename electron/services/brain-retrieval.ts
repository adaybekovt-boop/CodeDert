/**
 * Brain retrieval: score nodes against a query string, optionally expand
 * along the graph one hop, and return the top-N picks.
 *
 * Pure module — operates on plain BrainNode/BrainEdge arrays. The live service
 * passes its in-memory cache. Unit-testable without electron.
 */

export interface RetrievalNode {
  id: string;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  type: string;
  importance: number;
  confidence: number;
}

export interface RetrievalEdge {
  fromNodeId: string;
  toNodeId: string;
  type: string;
}

export interface ScoredNode {
  node: RetrievalNode;
  score: number;
  /** "match" | "neighbor" | "pinned" — useful for UI labelling. */
  via: 'match' | 'neighbor' | 'pinned';
  /** Tokens that contributed to the score, for debugging. */
  matchedTokens?: string[];
}

const STOP = new Set([
  'the','a','an','of','to','in','for','and','or','but','is','are','was','were','be','been','being',
  'i','you','we','they','it','this','that','these','those','my','your','our','their','its','as','at',
  'on','with','by','from','into','about','if','then','than','so','do','does','did','have','has','had',
  'will','would','can','could','should','may','might','must','not','no','yes',
  // common code chat fillers
  'use','using','used','make','made','need','want','like','also','just','should','code','file','files',
]);

export function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .split(/[^a-z0-9_-]+/g)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

interface ScoreParams {
  /** Per-node field weights — bigger for title/tags than for content body. */
  titleWeight?: number;
  summaryWeight?: number;
  tagsWeight?: number;
  contentWeight?: number;
  /** How much importance/confidence boost the final score. */
  importanceBoost?: number;
  confidenceBoost?: number;
}

const DEFAULT_SCORE: Required<ScoreParams> = {
  titleWeight: 4,
  summaryWeight: 2,
  tagsWeight: 3,
  contentWeight: 1,
  importanceBoost: 1.2,
  confidenceBoost: 0.8,
};

/**
 * Score a single node against the query token bag.
 */
export function scoreNode(node: RetrievalNode, queryTokens: string[], params: ScoreParams = {}): number {
  const cfg = { ...DEFAULT_SCORE, ...params };
  if (queryTokens.length === 0) return 0;

  const titleTokens = new Set(tokenize(node.title));
  const summaryTokens = new Set(tokenize(node.summary));
  const contentTokens = new Set(tokenize(node.content));
  const tagTokens = new Set(node.tags.map((t) => t.toLowerCase()));

  let raw = 0;
  for (const qt of queryTokens) {
    if (titleTokens.has(qt)) raw += cfg.titleWeight;
    if (summaryTokens.has(qt)) raw += cfg.summaryWeight;
    if (contentTokens.has(qt)) raw += cfg.contentWeight;
    if (tagTokens.has(qt)) raw += cfg.tagsWeight;
  }
  if (raw === 0) return 0;

  // Length normalization — don't let huge nodes dominate.
  const lengthPenalty = 1 / (1 + Math.log10(1 + node.content.length / 1000));
  const importanceFactor = 1 + cfg.importanceBoost * (node.importance || 0);
  const confidenceFactor = 1 + cfg.confidenceBoost * (node.confidence || 0);

  return raw * lengthPenalty * importanceFactor * confidenceFactor;
}

export interface RetrieveOptions {
  /** Hard cap on returned nodes. */
  limit?: number;
  /** Minimum score to include (post-boost). */
  minScore?: number;
  /** Pinned IDs that always go in first regardless of score. */
  pinnedIds?: string[];
  /** If true and after scoring we have budget, expand 1 hop into the graph. */
  expandNeighbors?: boolean;
  /** Filter to a subset of types. */
  types?: string[];
  /** Filter to a subset of tags. */
  tags?: string[];
}

export function retrieve(
  nodes: RetrievalNode[],
  edges: RetrievalEdge[],
  query: string,
  opts: RetrieveOptions = {}
): ScoredNode[] {
  const limit = Math.max(1, opts.limit ?? 5);
  const minScore = opts.minScore ?? 0.5;
  const queryTokens = tokenize(query);
  const pinnedSet = new Set(opts.pinnedIds || []);

  let pool = nodes;
  if (opts.types && opts.types.length > 0) {
    const t = new Set(opts.types);
    pool = pool.filter((n) => t.has(n.type));
  }
  if (opts.tags && opts.tags.length > 0) {
    const t = new Set(opts.tags.map((s) => s.toLowerCase()));
    pool = pool.filter((n) => n.tags.some((tag) => t.has(tag.toLowerCase())));
  }

  // Pinned nodes always first.
  const out: ScoredNode[] = [];
  for (const id of pinnedSet) {
    const n = pool.find((x) => x.id === id);
    if (n) out.push({ node: n, score: Infinity, via: 'pinned' });
  }

  // Score everything else.
  const scored: ScoredNode[] = [];
  for (const n of pool) {
    if (pinnedSet.has(n.id)) continue;
    const s = scoreNode(n, queryTokens);
    if (s >= minScore) scored.push({ node: n, score: s, via: 'match' });
  }
  scored.sort((a, b) => b.score - a.score);

  for (const s of scored) {
    if (out.length >= limit) break;
    out.push(s);
  }

  // 1-hop expansion if there's budget.
  if (opts.expandNeighbors && out.length < limit) {
    const picked = new Set(out.map((x) => x.node.id));
    const adjacency = buildAdjacency(edges);
    for (const seed of [...out]) {
      if (out.length >= limit) break;
      const neighbors = adjacency.get(seed.node.id) || [];
      for (const nid of neighbors) {
        if (picked.has(nid)) continue;
        const n = nodes.find((x) => x.id === nid);
        if (!n) continue;
        picked.add(nid);
        out.push({ node: n, score: seed.score * 0.3, via: 'neighbor' });
        if (out.length >= limit) break;
      }
    }
  }

  return out;
}

function buildAdjacency(edges: RetrievalEdge[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const e of edges) {
    if (!map.has(e.fromNodeId)) map.set(e.fromNodeId, []);
    if (!map.has(e.toNodeId)) map.set(e.toNodeId, []);
    map.get(e.fromNodeId)!.push(e.toNodeId);
    map.get(e.toNodeId)!.push(e.fromNodeId);
  }
  return map;
}
