import Store from 'electron-store';
import { randomBytes } from 'node:crypto';
import type { BrainNodeType, ExtractedCandidate } from './brain-extractor.js';
import { BRAIN_NODE_TYPES, extractCandidates, titleSimilarity } from './brain-extractor.js';
import { containsSecret } from './brain-secrets.js';
import { retrieve, type ScoredNode } from './brain-retrieval.js';
import { appSettings } from './settings.js';

/**
 * Brain service — durable JSON-backed knowledge graph.
 *
 * Storage layout (`codedert-brain.json` via electron-store):
 *   {
 *     nodes: BrainNode[],
 *     edges: BrainEdge[],
 *     suggestions: BrainSuggestion[]
 *   }
 *
 * All mutations go through the service so consumers can rely on the in-memory
 * cache (`state`) being canonical. Writes are debounced (250ms) to avoid
 * thrashing disk on rapid edits during graph drag.
 *
 * NOT used: SQLite/embeddings. v1 stays simple. Scale ceiling is ~10k nodes
 * before persistence cost becomes noticeable — acceptable for personal use.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type BrainEdgeType =
  | 'related'
  | 'depends_on'
  | 'conflicts_with'
  | 'improves'
  | 'caused_by'
  | 'used_in'
  | 'similar_to'
  | 'part_of'
  | 'mentions'
  | 'blocks';

const BRAIN_EDGE_TYPES: BrainEdgeType[] = [
  'related',
  'depends_on',
  'conflicts_with',
  'improves',
  'caused_by',
  'used_in',
  'similar_to',
  'part_of',
  'mentions',
  'blocks',
];

const MAX_STATE_NODES = 500;
const MAX_STATE_EDGES = 1200;
const MAX_STATE_SUGGESTIONS = 100;

export interface BrainNode {
  id: string;
  title: string;
  type: BrainNodeType;
  summary: string;
  content: string;
  tags: string[];
  source: { kind: 'manual' | 'chat' | 'workflow' | 'import'; ref?: string };
  confidence: number;
  importance: number;
  createdAt: number;
  updatedAt: number;
  linkedFilePaths: string[];
  relatedNodeIds: string[];
  /** Persisted layout coords for the graph view; null = re-layout. */
  position?: { x: number; y: number } | null;
  /** Project (workspace path id) this node belongs to. Empty/undefined = global. */
  projectId?: string;
}

export interface BrainEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  type: BrainEdgeType;
  confidence: number;
  explanation?: string;
  createdAt: number;
}

export interface BrainSuggestion {
  id: string;
  status: 'pending' | 'accepted' | 'ignored';
  candidate: {
    title: string;
    type: BrainNodeType;
    summary: string;
    content: string;
    tags: string[];
    confidence: number;
    importance: number;
  };
  source: { kind: 'chat' | 'workflow' | 'manual'; ref?: string };
  createdAt: number;
  resolvedAt?: number;
}

export interface BrainState {
  nodes: BrainNode[];
  edges: BrainEdge[];
  suggestions: BrainSuggestion[];
}

// ── Persistence ─────────────────────────────────────────────────────────────

const store = new Store({ name: 'codedert-brain' });
const KEY = 'state';

let state: BrainState = loadInitial();
let saveTimer: NodeJS.Timeout | null = null;
const listeners = new Set<(s: BrainState) => void>();

// Active project context — set by the renderer when the workspace changes.
// Used to stamp new nodes and to scope what the panel shows.
let activeProjectId: string | null = null;
let activeProjectName = '';
let showAllProjects = false;

/** Derive a stable project id + display name from a workspace root path. */
function deriveProject(root?: string | null): { id: string; name: string } | null {
  if (typeof root !== 'string' || !root.trim()) return null;
  const norm = root.trim().replace(/[\\/]+$/, '');
  const name = norm.split(/[\\/]/).filter(Boolean).pop() || norm;
  return { id: norm.toLowerCase(), name };
}

function loadInitial(): BrainState {
  const raw = (store.get(KEY) as Partial<BrainState> | undefined) || {};
  return {
    nodes: Array.isArray(raw.nodes)
      ? (raw.nodes.map(normalizeImportedNode).filter(Boolean) as BrainNode[])
      : [],
    edges: Array.isArray(raw.edges)
      ? (raw.edges.map(normalizeImportedEdge).filter(Boolean) as BrainEdge[])
      : [],
    suggestions: Array.isArray(raw.suggestions)
      ? (raw.suggestions.map(normalizeImportedSuggestion).filter(Boolean) as BrainSuggestion[])
      : [],
  };
}

function persist(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    store.set(KEY, state);
    saveTimer = null;
  }, 250);
  for (const cb of listeners) {
    try {
      cb(snapshotState());
    } catch {
      /* swallow */
    }
  }
}

function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

// ── Service ─────────────────────────────────────────────────────────────────

export const brain = {
  state(): BrainState {
    return snapshotState();
  },

  onChange(fn: (s: BrainState) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  // ── Project context ───────────────────────────────────────
  /** Set the active project from a workspace root. null clears it. */
  setActiveProject(root: string | null): { id: string | null; name: string } {
    const p = deriveProject(root);
    activeProjectId = p?.id ?? null;
    activeProjectName = p?.name ?? '';
    // Re-emit so the panel re-scopes immediately.
    for (const cb of listeners) {
      try {
        cb(snapshotState());
      } catch {
        /* swallow */
      }
    }
    return { id: activeProjectId, name: activeProjectName };
  },

  activeProject(): { id: string | null; name: string; showAll: boolean } {
    return { id: activeProjectId, name: activeProjectName, showAll: showAllProjects };
  },

  setShowAllProjects(show: boolean): void {
    showAllProjects = !!show;
    for (const cb of listeners) {
      try {
        cb(snapshotState());
      } catch {
        /* swallow */
      }
    }
  },

  /**
   * Record an auto "what was done" entry for a project. Bypasses the
   * suggestion/review flow — it's a factual log, not a knowledge guess.
   * Gated by brain.enabled && brain.autoWorklog.
   */
  logWork(input: {
    title: string;
    summary?: string;
    details?: string;
    files?: string[];
    projectRoot?: string | null;
    sourceRef?: string;
  }): { ok: boolean; node?: BrainNode } {
    const settings = appSettings.get();
    if (!settings.brain.enabled || !settings.brain.autoWorklog) return { ok: false };
    const title = cleanText(input.title, 200);
    if (!title) return { ok: false };

    const proj = deriveProject(input.projectRoot) ?? (activeProjectId ? { id: activeProjectId, name: activeProjectName } : null);
    const files = cleanStringArray(input.files, 30, 500);
    const summary =
      cleanText(input.summary, 600) ||
      (files.length ? `Изменено файлов: ${files.length}` : 'Задача выполнена');
    const contentParts = [
      input.details ? cleanText(input.details, 8000) : '',
      files.length ? `\nФайлы:\n${files.map((f) => `- ${f}`).join('\n')}` : '',
    ].filter(Boolean);

    const created = brain.createNode({
      title,
      type: 'worklog',
      summary,
      content: contentParts.join('\n').trim(),
      tags: ['done', ...(proj?.name ? [proj.name.toLowerCase().slice(0, 32)] : [])],
      source: { kind: 'workflow', ref: cleanText(input.sourceRef, 200) || undefined },
      confidence: 1,
      importance: 0.5,
      linkedFilePaths: files,
      projectId: proj?.id,
    });
    return { ok: created.ok, node: created.node };
  },

  /** Worklog entries for a project (defaults to active), newest first. */
  worklog(projectRoot?: string | null, limit = 100): BrainNode[] {
    const id = deriveProject(projectRoot)?.id ?? activeProjectId;
    return state.nodes
      .filter((n) => n.type === 'worklog' && (!id || n.projectId === id))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, capLimit(limit, 100));
  },

  // ── Nodes ─────────────────────────────────────────────────
  listNodes(filter?: { type?: BrainNodeType; tag?: string; query?: string }): BrainNode[] {
    let out = state.nodes;
    if (filter?.type && isBrainNodeType(filter.type)) out = out.filter((n) => n.type === filter.type);
    if (filter?.tag) {
      const t = filter.tag.toLowerCase();
      out = out.filter((n) => n.tags.some((x) => x.toLowerCase() === t));
    }
    if (filter?.query && filter.query.trim()) {
      const q = filter.query.toLowerCase();
      out = out.filter(
        (n) =>
          n.title.toLowerCase().includes(q) ||
          n.summary.toLowerCase().includes(q) ||
          n.tags.some((t) => t.toLowerCase().includes(q))
      );
    }
    return out.slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_STATE_NODES);
  },

  getNode(nodeId: string): BrainNode | null {
    return state.nodes.find((n) => n.id === nodeId) || null;
  },

  createNode(
    input: Partial<BrainNode> & { title: string; type: BrainNodeType }
  ): { ok: boolean; node?: BrainNode; error?: string } {
    if (!isRecord(input)) return { ok: false, error: 'invalid node payload' };
    if (!isBrainNodeType(input.type)) return { ok: false, error: 'invalid node type' };
    if (typeof input.title !== 'string' || !input.title.trim()) {
      return { ok: false, error: 'title required' };
    }
    const candidate = `${input.title}\n${input.summary || ''}\n${input.content || ''}`;
    if (containsSecret(candidate)) {
      return { ok: false, error: 'content rejected: contains a secret or credential' };
    }
    const now = Date.now();
    const node: BrainNode = {
      id: id('node'),
      title: input.title.trim().slice(0, 200),
      type: input.type,
      summary: cleanText(input.summary, 600),
      content: cleanText(input.content, 20_000),
      tags: dedupeTags(input.tags || []),
      source: normalizeSource(input.source, 'manual'),
      confidence: clamp01(input.confidence ?? 0.9),
      importance: clamp01(input.importance ?? 0.6),
      createdAt: now,
      updatedAt: now,
      linkedFilePaths: cleanStringArray(input.linkedFilePaths, 20, 500),
      relatedNodeIds: cleanStringArray(input.relatedNodeIds, 100, 200),
      position: normalizePosition(input.position),
      // Stamp the active project unless caller passed one explicitly.
      projectId:
        typeof input.projectId === 'string' && input.projectId.trim()
          ? input.projectId.trim().toLowerCase().slice(0, 400)
          : activeProjectId || undefined,
    };
    state.nodes.push(node);
    persist();
    return { ok: true, node };
  },

  updateNode(
    nodeId: string,
    patch: Partial<BrainNode>
  ): { ok: boolean; node?: BrainNode; error?: string } {
    if (!isRecord(patch)) return { ok: false, error: 'invalid node patch' };
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node) return { ok: false, error: 'node not found' };
    if (patch.type !== undefined && !isBrainNodeType(patch.type)) {
      return { ok: false, error: 'invalid node type' };
    }
    const newTitle = typeof patch.title === 'string' ? patch.title.trim() : node.title;
    const newSummary = typeof patch.summary === 'string' ? patch.summary : node.summary;
    const newContent = typeof patch.content === 'string' ? patch.content : node.content;
    const text = `${newTitle}\n${newSummary}\n${newContent}`;
    if (containsSecret(text)) {
      return { ok: false, error: 'update rejected: contains a secret' };
    }
    Object.assign(node, {
      title: newTitle.slice(0, 200),
      summary: newSummary.slice(0, 600),
      content: newContent.slice(0, 20_000),
      type: patch.type ?? node.type,
      tags: patch.tags ? dedupeTags(patch.tags) : node.tags,
      confidence: patch.confidence !== undefined ? clamp01(patch.confidence) : node.confidence,
      importance: patch.importance !== undefined ? clamp01(patch.importance) : node.importance,
      linkedFilePaths: patch.linkedFilePaths ? cleanStringArray(patch.linkedFilePaths, 20, 500) : node.linkedFilePaths,
      relatedNodeIds: patch.relatedNodeIds ? cleanStringArray(patch.relatedNodeIds, 100, 200) : node.relatedNodeIds,
      position: patch.position !== undefined ? normalizePosition(patch.position) : node.position,
      updatedAt: Date.now(),
    });
    persist();
    return { ok: true, node };
  },

  deleteNode(nodeId: string): { ok: boolean } {
    const before = state.nodes.length;
    state.nodes = state.nodes.filter((n) => n.id !== nodeId);
    state.edges = state.edges.filter((e) => e.fromNodeId !== nodeId && e.toNodeId !== nodeId);
    if (state.nodes.length !== before) persist();
    return { ok: state.nodes.length !== before };
  },

  // ── Edges ─────────────────────────────────────────────────
  listEdges(): BrainEdge[] {
    return state.edges.slice();
  },

  createEdge(input: Omit<BrainEdge, 'id' | 'createdAt'>): { ok: boolean; edge?: BrainEdge; error?: string } {
    if (!isRecord(input)) return { ok: false, error: 'invalid edge payload' };
    if (!isBrainEdgeType(input.type)) return { ok: false, error: 'invalid edge type' };
    if (typeof input.fromNodeId !== 'string' || typeof input.toNodeId !== 'string') {
      return { ok: false, error: 'edge endpoints required' };
    }
    if (input.fromNodeId === input.toNodeId) return { ok: false, error: 'self-loops not allowed' };
    if (!brain.getNode(input.fromNodeId) || !brain.getNode(input.toNodeId)) {
      return { ok: false, error: 'both nodes must exist' };
    }
    // Don't allow exact duplicates.
    const dup = state.edges.find(
      (e) =>
        e.fromNodeId === input.fromNodeId &&
        e.toNodeId === input.toNodeId &&
        e.type === input.type
    );
    if (dup) return { ok: true, edge: dup };

    const edge: BrainEdge = {
      id: id('edge'),
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      type: input.type,
      confidence: clamp01(input.confidence ?? 0.7),
      explanation: cleanText(input.explanation, 600),
      createdAt: Date.now(),
    };
    state.edges.push(edge);
    persist();
    return { ok: true, edge };
  },

  deleteEdge(edgeId: string): { ok: boolean } {
    const before = state.edges.length;
    state.edges = state.edges.filter((e) => e.id !== edgeId);
    if (state.edges.length !== before) persist();
    return { ok: state.edges.length !== before };
  },

  // ── Suggestions ───────────────────────────────────────────
  listSuggestions(status?: BrainSuggestion['status']): BrainSuggestion[] {
    const out = state.suggestions.slice().sort((a, b) => b.createdAt - a.createdAt);
    return status ? out.filter((s) => s.status === status) : out;
  },

  proposeFromChat(input: {
    user: string;
    assistant: string;
    contextFiles?: string[];
    sourceRef?: string;
  }): { added: number; rejectedSecrets: number; rejectedDuplicates: number; rejectedLowConfidence: number } {
    const settings = appSettings.get();
    if (!settings.brain.enabled || !settings.brain.autoCapture) {
      return { added: 0, rejectedSecrets: 0, rejectedDuplicates: 0, rejectedLowConfidence: 0 };
    }
    const cap = settings.brain.maxSuggestionsPerConversation;
    let added = 0;
    let rejectedSecrets = 0;
    let rejectedDuplicates = 0;
    let rejectedLowConfidence = 0;

    const candidates = extractCandidates(input);
    for (const c of candidates) {
      if (added >= cap) break;
      if (containsSecret(`${c.title}\n${c.content}`)) {
        rejectedSecrets += 1;
        continue;
      }
      if (c.confidence < settings.brain.minConfidence) {
        rejectedLowConfidence += 1;
        continue;
      }
      if (isDuplicate(c, settings.brain.dedupSimilarityThreshold)) {
        rejectedDuplicates += 1;
        continue;
      }
      if (settings.brain.requireReview) {
        const suggestion: BrainSuggestion = {
          id: id('sug'),
          status: 'pending',
          candidate: {
            title: cleanText(c.title, 200),
            type: c.type,
            summary: cleanText(c.summary, 600),
            content: cleanText(c.content, 20_000),
            tags: dedupeTags(c.tags),
            confidence: clamp01(c.confidence),
            importance: clamp01(c.importance),
          },
          source: { kind: 'chat', ref: cleanText(input.sourceRef, 200) },
          createdAt: Date.now(),
        };
        state.suggestions.push(suggestion);
      } else {
        const created = brain.createNode({
          title: c.title,
          type: c.type,
          summary: c.summary,
          content: c.content,
          tags: c.tags,
          confidence: c.confidence,
          importance: c.importance,
          source: { kind: 'chat', ref: input.sourceRef },
          linkedFilePaths: cleanStringArray(input.contextFiles, 20, 500),
        });
        if (!created.ok) continue;
      }
      added += 1;
    }

    if (added > 0) persist();
    return { added, rejectedSecrets, rejectedDuplicates, rejectedLowConfidence };
  },

  resolveSuggestion(
    suggestionId: string,
    decision: 'accept' | 'ignore',
    edits?: Partial<BrainNode>
  ): { ok: boolean; node?: BrainNode; error?: string } {
    const s = state.suggestions.find((x) => x.id === suggestionId);
    if (!s) return { ok: false, error: 'suggestion not found' };
    if (s.status !== 'pending') return { ok: false, error: `already ${s.status}` };

    if (decision === 'ignore') {
      s.status = 'ignored';
      s.resolvedAt = Date.now();
      persist();
      return { ok: true };
    }

    const create = brain.createNode({
      title: typeof edits?.title === 'string' ? edits.title : s.candidate.title,
      type: isBrainNodeType(edits?.type) ? edits.type : s.candidate.type,
      summary: typeof edits?.summary === 'string' ? edits.summary : s.candidate.summary,
      content: typeof edits?.content === 'string' ? edits.content : s.candidate.content,
      tags: Array.isArray(edits?.tags) ? edits.tags : s.candidate.tags,
      confidence: typeof edits?.confidence === 'number' ? edits.confidence : s.candidate.confidence,
      importance: typeof edits?.importance === 'number' ? edits.importance : s.candidate.importance,
      source: { kind: 'chat', ref: s.source.ref },
      linkedFilePaths: cleanStringArray(edits?.linkedFilePaths, 20, 500),
    });
    if (!create.ok) return create;
    s.status = 'accepted';
    s.resolvedAt = Date.now();
    persist();
    return { ok: true, node: create.node };
  },

  clearResolvedSuggestions(): { removed: number } {
    const before = state.suggestions.length;
    state.suggestions = state.suggestions.filter((s) => s.status === 'pending');
    if (state.suggestions.length !== before) persist();
    return { removed: before - state.suggestions.length };
  },

  // ── Retrieval ─────────────────────────────────────────────
  search(query: string, limit = 20): BrainNode[] {
    const ids = retrieve(state.nodes, state.edges, String(query || ''), { limit: capLimit(limit, 20), minScore: 0.3 }).map(
      (s) => s.node.id
    );
    return ids.map((id) => state.nodes.find((n) => n.id === id)!).filter(Boolean);
  },

  related(nodeId: string, limit = 8): BrainNode[] {
    const seed = brain.getNode(nodeId);
    if (!seed) return [];
    const text = `${seed.title} ${seed.summary} ${seed.tags.join(' ')}`;
    const ids = retrieve(state.nodes.filter((n) => n.id !== nodeId), state.edges, text, {
      limit: capLimit(limit, 8),
      minScore: 0.4,
      expandNeighbors: true,
    }).map((s) => s.node.id);
    return ids.map((id) => state.nodes.find((n) => n.id === id)!).filter(Boolean);
  },

  retrieveForPrompt(prompt: string, limitOverride?: number): ScoredNode[] {
    const settings = appSettings.get();
    if (!settings.brain.enabled || !settings.brain.injectRelevantNotes) return [];
    const limit = capLimit(limitOverride ?? settings.brain.maxInjectedNodes, settings.brain.maxInjectedNodes);
    if (limit <= 0) return [];
    return retrieve(state.nodes, state.edges, String(prompt || ''), {
      limit,
      minScore: 0.6,
      expandNeighbors: true,
    });
  },

  forget(query: string): { archived: number } {
    // Soft delete by matching title or id substring. Returns count.
    const q = query.trim().toLowerCase();
    if (!q) return { archived: 0 };
    const before = state.nodes.length;
    state.nodes = state.nodes.filter((n) => {
      if (n.id === query) return false;
      const matches = n.title.toLowerCase().includes(q) || n.tags.some((t) => t.toLowerCase() === q);
      return !matches;
    });
    state.edges = state.edges.filter((e) => state.nodes.some((n) => n.id === e.fromNodeId) && state.nodes.some((n) => n.id === e.toNodeId));
    const removed = before - state.nodes.length;
    if (removed > 0) persist();
    return { archived: removed };
  },

  // ── Bulk / diagnostics ────────────────────────────────────
  export(): BrainState {
    return JSON.parse(JSON.stringify(state));
  },

  import(blob: BrainState, mode: 'merge' | 'replace' = 'merge'): { ok: boolean; addedNodes: number; addedEdges: number } {
    if (!blob || !Array.isArray(blob.nodes) || !Array.isArray(blob.edges)) {
      return { ok: false, addedNodes: 0, addedEdges: 0 };
    }
    if (mode === 'replace') {
      state = { nodes: [], edges: [], suggestions: [] };
    }
    let addedNodes = 0;
    let addedEdges = 0;
    for (const n of blob.nodes) {
      const normalized = normalizeImportedNode(n);
      if (!normalized) continue;
      if (state.nodes.find((x) => x.id === normalized.id)) continue;
      if (containsSecret(`${normalized.title}\n${normalized.content || ''}`)) continue;
      state.nodes.push(normalized);
      addedNodes += 1;
    }
    for (const e of blob.edges) {
      const normalized = normalizeImportedEdge(e);
      if (!normalized || !state.nodes.find((n) => n.id === normalized.fromNodeId) || !state.nodes.find((n) => n.id === normalized.toNodeId)) {
        continue;
      }
      if (state.edges.find((x) => x.id === normalized.id)) continue;
      state.edges.push(normalized);
      addedEdges += 1;
    }
    persist();
    return { ok: true, addedNodes, addedEdges };
  },

  stats(): { nodes: number; edges: number; pending: number; byType: Record<string, number> } {
    const byType: Record<string, number> = {};
    for (const n of state.nodes) byType[n.type] = (byType[n.type] || 0) + 1;
    return {
      nodes: state.nodes.length,
      edges: state.edges.length,
      pending: state.suggestions.filter((s) => s.status === 'pending').length,
      byType,
    };
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function capLimit(value: unknown, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return Math.max(0, Math.min(50, fallback));
  return Math.max(0, Math.min(50, n));
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isBrainNodeType(value: unknown): value is BrainNodeType {
  return typeof value === 'string' && BRAIN_NODE_TYPES.includes(value as BrainNodeType);
}

function isBrainEdgeType(value: unknown): value is BrainEdgeType {
  return typeof value === 'string' && BRAIN_EDGE_TYPES.includes(value as BrainEdgeType);
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function cleanStringArray(value: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const cleaned = item.trim().slice(0, maxLen);
    if (cleaned) out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return Array.from(new Set(out));
}

function normalizeSource(
  source: unknown,
  fallback: BrainNode['source']['kind']
): BrainNode['source'] {
  if (!isRecord(source)) return { kind: fallback };
  const kind = source.kind;
  if (kind !== 'manual' && kind !== 'chat' && kind !== 'workflow' && kind !== 'import') {
    return { kind: fallback };
  }
  const ref = cleanText(source.ref, 200);
  return ref ? { kind, ref } : { kind };
}

function normalizePosition(value: unknown): BrainNode['position'] {
  if (value == null) return null;
  if (!isRecord(value)) return null;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.max(-100_000, Math.min(100_000, x)),
    y: Math.max(-100_000, Math.min(100_000, y)),
  };
}

function normalizeImportedNode(value: unknown): BrainNode | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || !value.id.trim()) return null;
  if (!isBrainNodeType(value.type)) return null;
  if (typeof value.title !== 'string' || !value.title.trim()) return null;
  const now = Date.now();
  const title = cleanText(value.title, 200);
  const summary = cleanText(value.summary, 600);
  const content = cleanText(value.content, 20_000);
  if (containsSecret(`${title}\n${summary}\n${content}`)) return null;
  return {
    id: value.id.trim().slice(0, 120),
    title,
    type: value.type,
    summary,
    content,
    tags: dedupeTags(value.tags || []),
    source: normalizeSource(value.source, 'import'),
    confidence: clamp01(Number(value.confidence ?? 0.7)),
    importance: clamp01(Number(value.importance ?? 0.5)),
    createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : now,
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : now,
    linkedFilePaths: cleanStringArray(value.linkedFilePaths, 20, 500),
    relatedNodeIds: cleanStringArray(value.relatedNodeIds, 100, 200),
    position: normalizePosition(value.position),
    projectId:
      typeof value.projectId === 'string' && value.projectId.trim()
        ? value.projectId.trim().toLowerCase().slice(0, 400)
        : undefined,
  };
}

function normalizeImportedEdge(value: unknown): BrainEdge | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || !value.id.trim()) return null;
  if (typeof value.fromNodeId !== 'string' || typeof value.toNodeId !== 'string') return null;
  if (value.fromNodeId === value.toNodeId) return null;
  if (!isBrainEdgeType(value.type)) return null;
  return {
    id: value.id.trim().slice(0, 120),
    fromNodeId: value.fromNodeId.trim().slice(0, 120),
    toNodeId: value.toNodeId.trim().slice(0, 120),
    type: value.type,
    confidence: clamp01(Number(value.confidence ?? 0.7)),
    explanation: cleanText(value.explanation, 600),
    createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : Date.now(),
  };
}

function normalizeImportedSuggestion(value: unknown): BrainSuggestion | null {
  if (!isRecord(value) || !isRecord(value.candidate)) return null;
  if (typeof value.id !== 'string' || !value.id.trim()) return null;
  if (value.status !== 'pending' && value.status !== 'accepted' && value.status !== 'ignored') return null;
  if (!isBrainNodeType(value.candidate.type)) return null;
  const title = cleanText(value.candidate.title, 200);
  const summary = cleanText(value.candidate.summary, 600);
  const content = cleanText(value.candidate.content, 20_000);
  if (!title || containsSecret(`${title}\n${summary}\n${content}`)) return null;
  return {
    id: value.id.trim().slice(0, 120),
    status: value.status,
    candidate: {
      title,
      type: value.candidate.type,
      summary,
      content,
      tags: dedupeTags(value.candidate.tags || []),
      confidence: clamp01(Number(value.candidate.confidence ?? 0.7)),
      importance: clamp01(Number(value.candidate.importance ?? 0.5)),
    },
    source: normalizeSource(value.source, 'chat') as BrainSuggestion['source'],
    createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : Date.now(),
    resolvedAt: Number.isFinite(Number(value.resolvedAt)) ? Number(value.resolvedAt) : undefined,
  };
}

function snapshotState(): BrainState {
  const scope = appSettings.get().brain.scopeToProject;
  const base =
    scope && activeProjectId && !showAllProjects
      ? // Current project's nodes + un-scoped (global/legacy) nodes.
        state.nodes.filter((n) => n.projectId === activeProjectId || !n.projectId)
      : state.nodes;
  const nodes = base
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_STATE_NODES);
  const idSet = new Set(nodes.map((n) => n.id));
  return {
    nodes,
    edges: state.edges
      .filter((e) => idSet.has(e.fromNodeId) && idSet.has(e.toNodeId))
      .slice(0, MAX_STATE_EDGES),
    suggestions: state.suggestions
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_STATE_SUGGESTIONS),
  };
}

function dedupeTags(tags: string[]): string[] {
  const out = new Set<string>();
  for (const t of tags) {
    const cleaned = String(t || '').trim().toLowerCase().slice(0, 32);
    if (cleaned) out.add(cleaned);
  }
  return Array.from(out).slice(0, 20);
}

function isDuplicate(c: ExtractedCandidate, threshold: number): boolean {
  for (const n of state.nodes) {
    if (n.type !== c.type) continue;
    if (titleSimilarity(c.title, n.title) >= threshold) return true;
  }
  for (const s of state.suggestions) {
    if (s.status !== 'pending') continue;
    if (s.candidate.type !== c.type) continue;
    if (titleSimilarity(c.title, s.candidate.title) >= threshold) return true;
  }
  return false;
}
