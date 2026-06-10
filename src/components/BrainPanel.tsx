import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge as RFEdge,
  type Node as RFNode,
  type NodeChange,
  useEdgesState,
  useNodesState,
  applyNodeChanges,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Brain,
  Search,
  Plus,
  Tag,
  Trash2,
  Pin,
  PinOff,
  Check,
  X,
  Edit3,
  AlertCircle,
  History,
  Network,
  Globe,
  FileText,
} from 'lucide-react';
import { useBrainStore } from '../lib/brain-store';
import {
  BRAIN_TYPE_COLORS,
  BRAIN_TYPES,
  type BrainNode,
  type BrainNodeType,
  type BrainSuggestion,
} from '../lib/brain-types';
import { cn } from '../lib/utils';

/**
 * The Brain tab — full-screen knowledge graph plus side panels.
 *
 * Layout (CSS grid):
 *   ┌──────────────┬──────────────────────────────┬──────────────────┐
 *   │ types/tags   │  graph (reactflow)           │ details / context│
 *   │ recents      │                              │                  │
 *   ├──────────────┴──────────────────────────────┴──────────────────┤
 *   │ Suggestions strip (collapsible)                                │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * The graph syncs with the main-process brain state via `useBrainStore`.
 * Node drags persist positions via `brain.updateNode`. We debounce position
 * writes to 250ms to avoid IPC storm.
 */

export function BrainPanel() {
  const { nodes, edges, suggestions, selectedNodeId, select, bootstrap, pinnedIds, togglePin } =
    useBrainStore();
  const [typeFilter, setTypeFilter] = useState<BrainNodeType | 'all'>('all');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<'graph' | 'worklog'>('graph');
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  function toggleShowAll() {
    const next = !showAll;
    setShowAll(next);
    window.api.brain.setShowAll(next).catch(() => {});
  }

  // "What was done" timeline — worklog entries newest-first.
  const worklogEntries = useMemo(
    () =>
      nodes
        .filter((n) => n.type === 'worklog')
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt),
    [nodes]
  );

  const filteredNodes = useMemo(() => {
    const q = search.trim().toLowerCase();
    return nodes.filter((n) => {
      if (n.type === 'worklog') return false; // worklog lives in its own timeline
      if (typeFilter !== 'all' && n.type !== typeFilter) return false;
      if (tagFilter && !n.tags.some((t) => t.toLowerCase() === tagFilter.toLowerCase())) return false;
      if (q) {
        const hay = `${n.title} ${n.summary} ${n.tags.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [nodes, typeFilter, tagFilter, search]);

  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of nodes) for (const t of n.tags) counts.set(t, (counts.get(t) || 0) + 1);
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40);
  }, [nodes]);

  const pendingSuggestions = useMemo(
    () => suggestions.filter((s) => s.status === 'pending'),
    [suggestions]
  );
  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) || null,
    [nodes, selectedNodeId]
  );

  return (
    <div className="flex flex-1 min-w-0 h-full">
      {/* Left sidebar: types + tags + recents */}
      <div className="w-56 border-r border-bg-border bg-bg-panel flex flex-col">
        <div className="px-3 py-2 border-b border-bg-border flex items-center gap-2">
          <Brain className="w-4 h-4 text-accent" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
            Brain
          </h2>
          <button
            onClick={() => setCreating(true)}
            title="Create note"
            className="ml-auto p-1 text-text-secondary hover:text-text-primary rounded hover:bg-bg-elevated"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="p-2 border-b border-bg-border">
          <div className="relative">
            <Search className="w-3 h-3 absolute left-2 top-2 text-text-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              className="input pl-7 text-xs py-1"
            />
          </div>
        </div>

        <div className="overflow-auto flex-1">
          <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-text-muted">
            Types
          </div>
          <button
            onClick={() => setTypeFilter('all')}
            className={cn(
              'w-full px-3 py-1 text-xs text-left flex justify-between',
              typeFilter === 'all' ? 'bg-accent/10 text-accent' : 'hover:bg-bg-elevated text-text-secondary'
            )}
          >
            <span>All</span>
            <span className="text-text-muted">{nodes.length}</span>
          </button>
          {BRAIN_TYPES.map((t) => {
            const count = nodes.filter((n) => n.type === t).length;
            if (count === 0) return null;
            return (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                className={cn(
                  'w-full px-3 py-1 text-xs text-left flex justify-between items-center',
                  typeFilter === t ? 'bg-accent/10 text-accent' : 'hover:bg-bg-elevated text-text-secondary'
                )}
              >
                <span className="flex items-center gap-2">
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ background: BRAIN_TYPE_COLORS[t] }}
                  />
                  {t}
                </span>
                <span className="text-text-muted">{count}</span>
              </button>
            );
          })}

          {allTags.length > 0 && (
            <>
              <div className="px-3 py-2 mt-2 text-[10px] uppercase tracking-wider text-text-muted">
                Tags
              </div>
              {allTags.map(([tag, count]) => (
                <button
                  key={tag}
                  onClick={() => setTagFilter(tag === tagFilter ? null : tag)}
                  className={cn(
                    'w-full px-3 py-1 text-xs text-left flex justify-between',
                    tagFilter === tag
                      ? 'bg-accent/10 text-accent'
                      : 'hover:bg-bg-elevated text-text-secondary'
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <Tag className="w-2.5 h-2.5" /> {tag}
                  </span>
                  <span className="text-text-muted">{count}</span>
                </button>
              ))}
            </>
          )}
        </div>

        <div className="px-3 py-2 border-t border-bg-border text-[10px] text-text-muted">
          {nodes.length} nodes · {edges.length} edges · {pendingSuggestions.length} pending
        </div>
      </div>

      {/* Center: view toggle + graph or worklog */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-bg-border bg-bg-panel">
          <button
            onClick={() => setView('graph')}
            className={cn(
              'text-xs px-2.5 py-1 rounded flex items-center gap-1.5',
              view === 'graph' ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-bg-elevated'
            )}
          >
            <Network className="w-3.5 h-3.5" /> Граф
          </button>
          <button
            onClick={() => setView('worklog')}
            className={cn(
              'text-xs px-2.5 py-1 rounded flex items-center gap-1.5',
              view === 'worklog' ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-bg-elevated'
            )}
          >
            <History className="w-3.5 h-3.5" /> Что сделано
            {worklogEntries.length > 0 && (
              <span className="text-[10px] text-text-muted">({worklogEntries.length})</span>
            )}
          </button>
          <button
            onClick={toggleShowAll}
            title={showAll ? 'Показаны все проекты' : 'Показан текущий проект'}
            className={cn(
              'ml-auto text-xs px-2.5 py-1 rounded flex items-center gap-1.5',
              showAll ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-bg-elevated'
            )}
          >
            <Globe className="w-3.5 h-3.5" /> {showAll ? 'Все проекты' : 'Текущий проект'}
          </button>
        </div>

        {view === 'graph' ? (
          <GraphView
            nodes={filteredNodes}
            allEdges={edges}
            selectedId={selectedNodeId}
            onSelect={select}
          />
        ) : (
          <WorklogView entries={worklogEntries} />
        )}

        {/* Suggestions strip */}
        <div className="border-t border-bg-border bg-bg-panel">
          <button
            onClick={() => setShowSuggestions((s) => !s)}
            className="w-full px-3 py-1.5 text-xs flex items-center justify-between text-text-secondary hover:text-text-primary"
          >
            <span className="flex items-center gap-2">
              <AlertCircle className="w-3 h-3" />
              Pending suggestions ({pendingSuggestions.length})
            </span>
            <span className="text-[10px]">{showSuggestions ? 'hide' : 'show'}</span>
          </button>
          {showSuggestions && (
            <SuggestionsStrip suggestions={pendingSuggestions.slice(0, 10)} />
          )}
        </div>
      </div>

      {/* Right: node details / context */}
      <div className="w-80 border-l border-bg-border bg-bg-panel flex flex-col">
        <NodeDetailsPanel
          node={selectedNode}
          pinned={selectedNode ? pinnedIds.includes(selectedNode.id) : false}
          onTogglePin={() => selectedNode && togglePin(selectedNode.id)}
        />
        <ActiveContextPanel />
      </div>

      {creating && <CreateNodeDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

// ── Graph ────────────────────────────────────────────────────────────────────

function GraphView({
  nodes: brainNodes,
  allEdges,
  selectedId,
  onSelect,
}: {
  nodes: BrainNode[];
  allEdges: { id: string; fromNodeId: string; toNodeId: string; type: string }[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  // Map BrainNode -> RFNode with deterministic layout for un-positioned nodes.
  const initialRfNodes: RFNode[] = useMemo(
    () =>
      brainNodes.map((n, i) => {
        const fallback = circlePosition(i, brainNodes.length);
        const pos = n.position || fallback;
        return {
          id: n.id,
          position: pos,
          data: { label: n.title, type: n.type, brainNode: n },
          type: 'brainNode',
          selected: n.id === selectedId,
        };
      }),
    // We intentionally exclude `selectedId` so reactflow doesn't reset positions
    // on every selection change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [brainNodes]
  );

  const idSet = useMemo(() => new Set(brainNodes.map((n) => n.id)), [brainNodes]);
  const initialRfEdges: RFEdge[] = useMemo(
    () =>
      allEdges
        .filter((e) => idSet.has(e.fromNodeId) && idSet.has(e.toNodeId))
        .map((e) => ({
          id: e.id,
          source: e.fromNodeId,
          target: e.toNodeId,
          label: e.type,
          animated: e.type === 'depends_on' || e.type === 'blocks',
          style: edgeStyleFor(e.type),
          labelStyle: { fontSize: 9, fill: '#94a3b8' },
        })),
    [allEdges, idSet]
  );

  const [rfNodes, setRfNodes, onNodesChangeBase] = useNodesState<RFNode>(initialRfNodes);
  const [rfEdges, setRfEdges] = useEdgesState<RFEdge>(initialRfEdges);

  // Re-sync when the brain state changes.
  useEffect(() => {
    setRfNodes(initialRfNodes);
  }, [initialRfNodes, setRfNodes]);
  useEffect(() => {
    setRfEdges(initialRfEdges);
  }, [initialRfEdges, setRfEdges]);

  // Persist drag positions (debounced).
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setRfNodes((nds) => applyNodeChanges(changes, nds));
      for (const c of changes) {
        if (c.type === 'position' && c.position && !c.dragging) {
          window.api.brain
            .updateNode(c.id, { position: { x: c.position.x, y: c.position.y } })
            .catch(() => {});
        }
      }
    },
    [setRfNodes]
  );

  const nodeTypes = useMemo(() => ({ brainNode: BrainNodeRenderer }), []);

  if (brainNodes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted text-sm bg-bg">
        <div className="text-center">
          <Brain className="w-10 h-10 mx-auto mb-2 opacity-40" />
          <div>No Brain notes yet.</div>
          <div className="text-xs mt-1">
            Use the <code className="text-accent">+</code> button or type <code className="text-accent">/brain add &lt;text&gt;</code>.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 bg-bg">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, n) => onSelect(n.id)}
        onPaneClick={() => onSelect(null)}
        fitView
        minZoom={0.2}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} color="#1f2937" />
        <Controls className="!bg-bg-panel !border-bg-border" />
        <MiniMap
          className="!bg-bg-panel !border !border-bg-border"
          nodeColor={(n) => {
            const t = (n.data as any)?.type as BrainNodeType | undefined;
            return t ? BRAIN_TYPE_COLORS[t] : '#94a3b8';
          }}
          maskColor="rgba(13,17,23,0.7)"
        />
      </ReactFlow>
    </div>
  );
}

// ── "What was done" timeline ─────────────────────────────────────────────────

function WorklogView({ entries }: { entries: BrainNode[] }) {
  async function remove(id: string, title: string) {
    if (!window.confirm(`Удалить запись "${title}"?`)) return;
    await window.api.brain.deleteNode(id);
  }

  if (entries.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted text-sm bg-bg">
        <div className="text-center max-w-xs px-4">
          <History className="w-10 h-10 mx-auto mb-2 opacity-40" />
          <div>Журнал пуст.</div>
          <div className="text-xs mt-1">
            После каждой выполненной задачи (агент, <code className="text-accent">/edit</code>,{' '}
            <code className="text-accent">/multyplan</code>) сюда автоматически попадёт запись «что было сделано».
          </div>
        </div>
      </div>
    );
  }

  // Group entries by day for a readable timeline.
  const groups = new Map<string, BrainNode[]>();
  for (const e of entries) {
    const day = new Date(e.createdAt).toLocaleDateString();
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(e);
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto bg-bg p-4">
      <div className="max-w-2xl mx-auto space-y-5">
        {Array.from(groups.entries()).map(([day, items]) => (
          <div key={day}>
            <div className="text-[10px] uppercase tracking-wider text-text-muted mb-2 sticky top-0 bg-bg py-1">
              {day}
            </div>
            <div className="space-y-2">
              {items.map((e) => (
                <div
                  key={e.id}
                  className="group rounded-md border border-bg-border bg-bg-panel p-3 hover:border-accent/40 transition-colors"
                >
                  <div className="flex items-start gap-2">
                    <span
                      className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0"
                      style={{ background: BRAIN_TYPE_COLORS.worklog }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-text-primary">{e.title}</div>
                      {e.summary && (
                        <div className="text-xs text-text-secondary mt-0.5">{e.summary}</div>
                      )}
                      {e.linkedFilePaths.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {e.linkedFilePaths.slice(0, 8).map((f) => (
                            <span
                              key={f}
                              className="chip bg-bg-elevated text-text-muted text-[10px] flex items-center gap-1"
                              title={f}
                            >
                              <FileText className="w-2.5 h-2.5" />
                              {f.split(/[\\/]/).pop()}
                            </span>
                          ))}
                          {e.linkedFilePaths.length > 8 && (
                            <span className="text-[10px] text-text-muted">
                              +{e.linkedFilePaths.length - 8}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <span className="text-[10px] text-text-muted shrink-0">
                      {new Date(e.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <button
                      onClick={() => remove(e.id, e.title)}
                      title="Удалить"
                      className="p-1 rounded text-text-muted hover:text-rose-400 opacity-0 group-hover:opacity-100"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BrainNodeRenderer({ data, selected }: { data: any; selected?: boolean }) {
  const node: BrainNode = data.brainNode;
  const color = BRAIN_TYPE_COLORS[node.type];
  return (
    <div
      className={cn(
        'px-3 py-1.5 rounded-md border text-[11px] font-medium bg-bg-panel shadow-sm',
        selected ? 'ring-2 ring-accent' : ''
      )}
      style={{ borderColor: color, color: '#e5e7eb', maxWidth: 220 }}
    >
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
        <span className="truncate">{node.title}</span>
      </div>
      {node.tags.length > 0 && (
        <div className="text-[9px] text-text-muted mt-0.5 truncate">{node.tags.slice(0, 3).join(' · ')}</div>
      )}
    </div>
  );
}

function edgeStyleFor(type: string): React.CSSProperties {
  switch (type) {
    case 'depends_on':
      return { stroke: '#60a5fa', strokeWidth: 1.5 };
    case 'conflicts_with':
      return { stroke: '#f87171', strokeWidth: 1.5, strokeDasharray: '4 3' };
    case 'caused_by':
      return { stroke: '#fb923c', strokeWidth: 1.5 };
    case 'improves':
      return { stroke: '#34d399', strokeWidth: 1.5 };
    case 'blocks':
      return { stroke: '#ef4444', strokeWidth: 2, strokeDasharray: '6 3' };
    case 'similar_to':
      return { stroke: '#a78bfa', strokeWidth: 1, strokeDasharray: '2 3' };
    default:
      return { stroke: '#475569', strokeWidth: 1 };
  }
}

function circlePosition(i: number, total: number): { x: number; y: number } {
  const radius = Math.max(120, total * 24);
  const angle = (i / Math.max(1, total)) * Math.PI * 2;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

// ── Right panel: node details + active context ─────────────────────────────

function NodeDetailsPanel({
  node,
  pinned,
  onTogglePin,
}: {
  node: BrainNode | null;
  pinned: boolean;
  onTogglePin: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<BrainNode | null>(null);

  useEffect(() => {
    setEditing(false);
    setDraft(node);
  }, [node?.id]);

  if (!node) {
    return (
      <div className="p-4 text-xs text-text-muted">Select a node to see details.</div>
    );
  }
  const current = editing ? draft || node : node;

  async function save() {
    if (!draft) return;
    await window.api.brain.updateNode(draft.id, {
      title: draft.title,
      summary: draft.summary,
      content: draft.content,
      tags: draft.tags,
      importance: draft.importance,
    });
    setEditing(false);
  }

  async function remove() {
    if (!node) return;
    if (!window.confirm(`Delete "${node.title}"?`)) return;
    await window.api.brain.deleteNode(node.id);
  }

  return (
    <div className="p-3 border-b border-bg-border max-h-[60%] overflow-auto">
      <div className="flex items-center gap-2 mb-2">
        <span
          className="w-2 h-2 rounded-full"
          style={{ background: BRAIN_TYPE_COLORS[current.type] }}
        />
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          {current.type}
        </span>
        <div className="ml-auto flex gap-1">
          <button
            onClick={onTogglePin}
            title={pinned ? 'Unpin from context' : 'Pin into chat context'}
            className="p-1 hover:bg-bg-elevated rounded text-text-secondary"
          >
            {pinned ? <PinOff className="w-3 h-3" /> : <Pin className="w-3 h-3" />}
          </button>
          {!editing ? (
            <button
              onClick={() => setEditing(true)}
              title="Edit"
              className="p-1 hover:bg-bg-elevated rounded text-text-secondary"
            >
              <Edit3 className="w-3 h-3" />
            </button>
          ) : (
            <button
              onClick={save}
              className="p-1 hover:bg-bg-elevated rounded text-emerald-400"
              title="Save"
            >
              <Check className="w-3 h-3" />
            </button>
          )}
          <button
            onClick={remove}
            title="Delete"
            className="p-1 hover:bg-bg-elevated rounded text-rose-400"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {editing ? (
        <div className="space-y-2">
          <input
            value={draft?.title || ''}
            onChange={(e) => setDraft({ ...(draft as BrainNode), title: e.target.value })}
            className="input text-xs"
          />
          <textarea
            value={draft?.summary || ''}
            onChange={(e) => setDraft({ ...(draft as BrainNode), summary: e.target.value })}
            placeholder="Summary"
            className="input text-xs resize-none"
            rows={2}
          />
          <textarea
            value={draft?.content || ''}
            onChange={(e) => setDraft({ ...(draft as BrainNode), content: e.target.value })}
            placeholder="Content"
            className="input text-xs resize-none font-mono"
            rows={6}
          />
          <input
            value={(draft?.tags || []).join(', ')}
            onChange={(e) =>
              setDraft({
                ...(draft as BrainNode),
                tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
              })
            }
            placeholder="tags, comma-separated"
            className="input text-xs font-mono"
          />
        </div>
      ) : (
        <>
          <h3 className="text-sm font-medium mb-1">{current.title}</h3>
          {current.summary && (
            <p className="text-xs text-text-secondary mb-2 whitespace-pre-wrap">{current.summary}</p>
          )}
          {current.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {current.tags.map((t) => (
                <span key={t} className="chip bg-bg-elevated text-text-secondary">
                  #{t}
                </span>
              ))}
            </div>
          )}
          {current.content && (
            <pre className="text-[11px] text-text-secondary bg-bg rounded p-2 whitespace-pre-wrap font-mono max-h-48 overflow-auto">
              {current.content}
            </pre>
          )}
          <div className="text-[10px] text-text-muted mt-2 flex gap-3">
            <span>conf {Math.round(current.confidence * 100)}%</span>
            <span>imp {Math.round(current.importance * 100)}%</span>
            <span>{new Date(current.updatedAt).toLocaleDateString()}</span>
          </div>
        </>
      )}
    </div>
  );
}

function ActiveContextPanel() {
  const { lastInjection, pinnedIds, togglePin } = useBrainStore();
  const nodes = useBrainStore((s) => s.nodes);
  const pinned = useMemo(
    () => pinnedIds.map((id) => nodes.find((n) => n.id === id)).filter(Boolean) as BrainNode[],
    [pinnedIds, nodes]
  );
  return (
    <div className="p-3 flex-1 overflow-auto">
      <div className="text-[10px] uppercase tracking-wider text-text-muted mb-2">
        Active Brain Context
      </div>
      {pinned.length > 0 && (
        <>
          <div className="text-[10px] text-text-secondary mb-1">Pinned ({pinned.length})</div>
          {pinned.map((n) => (
            <div key={n.id} className="flex items-start gap-2 text-xs py-1 border-b border-bg-border">
              <span
                className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0"
                style={{ background: BRAIN_TYPE_COLORS[n.type] }}
              />
              <span className="flex-1 truncate" title={n.title}>{n.title}</span>
              <button
                onClick={() => togglePin(n.id)}
                title="Unpin"
                className="p-0.5 text-text-muted hover:text-text-primary"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </>
      )}
      <div className="text-[10px] text-text-secondary mt-3 mb-1">
        Last injection {lastInjection ? `· ${new Date(lastInjection.at).toLocaleTimeString()}` : ''}
      </div>
      {!lastInjection ? (
        <div className="text-[11px] text-text-muted">
          No retrieval yet. Send a chat message and the Brain will surface relevant memories here.
        </div>
      ) : lastInjection.results.length === 0 ? (
        <div className="text-[11px] text-text-muted">
          No relevant memories were injected for the last prompt.
        </div>
      ) : (
        lastInjection.results.map((r) => (
          <div key={r.node.id} className="flex items-start gap-2 text-xs py-1 border-b border-bg-border">
            <span
              className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0"
              style={{ background: BRAIN_TYPE_COLORS[r.node.type] }}
            />
            <div className="flex-1 min-w-0">
              <div className="truncate" title={r.node.title}>{r.node.title}</div>
              <div className="text-[9px] text-text-muted">
                via {r.via} · score {r.score.toFixed(2)}
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ── Suggestions strip ───────────────────────────────────────────────────────

function SuggestionsStrip({ suggestions }: { suggestions: BrainSuggestion[] }) {
  if (suggestions.length === 0) {
    return (
      <div className="px-3 py-2 text-[11px] text-text-muted">
        No pending suggestions. Chat with the AI — relevant ideas, decisions and TODOs will appear here.
      </div>
    );
  }
  return (
    <div className="flex gap-2 overflow-x-auto p-2">
      {suggestions.map((s) => (
        <SuggestionCard key={s.id} suggestion={s} />
      ))}
    </div>
  );
}

function SuggestionCard({ suggestion }: { suggestion: BrainSuggestion }) {
  const color = BRAIN_TYPE_COLORS[suggestion.candidate.type];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    title: suggestion.candidate.title,
    type: suggestion.candidate.type,
    summary: suggestion.candidate.summary,
    content: suggestion.candidate.content,
    tags: suggestion.candidate.tags.join(', '),
  });
  async function resolve(decision: 'accept' | 'ignore') {
    const edits = editing
      ? {
          title: draft.title,
          type: draft.type,
          summary: draft.summary,
          content: draft.content,
          tags: draft.tags.split(',').map((t) => t.trim()).filter(Boolean),
        }
      : undefined;
    await window.api.brain.resolveSuggestion(suggestion.id, decision, edits);
  }
  return (
    <div className="min-w-[280px] max-w-[320px] bg-bg rounded-md border border-bg-border p-2 shrink-0">
      <div className="flex items-center gap-1.5 mb-1">
        <span className="w-2 h-2 rounded-full" style={{ background: color }} />
        <span className="text-[10px] uppercase text-text-muted">{suggestion.candidate.type}</span>
        <span className="ml-auto text-[10px] text-text-muted">
          {Math.round(suggestion.candidate.confidence * 100)}%
        </span>
      </div>
      {editing ? (
        <div className="space-y-1 mb-2">
          <input
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            className="input text-[11px] py-1"
          />
          <select
            value={draft.type}
            onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value as BrainNodeType }))}
            className="input text-[11px] py-1"
          >
            {BRAIN_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <textarea
            value={draft.summary}
            onChange={(e) => setDraft((d) => ({ ...d, summary: e.target.value }))}
            className="input text-[11px] resize-none"
            rows={2}
          />
          <textarea
            value={draft.content}
            onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
            className="input text-[11px] resize-none font-mono"
            rows={3}
          />
          <input
            value={draft.tags}
            onChange={(e) => setDraft((d) => ({ ...d, tags: e.target.value }))}
            className="input text-[11px] py-1 font-mono"
            placeholder="tags, comma-separated"
          />
        </div>
      ) : (
        <>
          <div className="text-xs font-medium mb-1 truncate" title={suggestion.candidate.title}>
            {suggestion.candidate.title}
          </div>
          <div className="text-[10px] text-text-secondary mb-2 line-clamp-2">
            {suggestion.candidate.summary}
          </div>
        </>
      )}
      {suggestion.candidate.tags.length > 0 && !editing && (
        <div className="flex flex-wrap gap-1 mb-2">
          {suggestion.candidate.tags.slice(0, 4).map((t) => (
            <span key={t} className="chip text-[9px] bg-bg-elevated text-text-secondary">
              #{t}
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-1">
        <button
          onClick={() => resolve('accept')}
          className="flex-1 text-[10px] py-1 rounded bg-accent text-bg hover:bg-accent-hover flex items-center justify-center gap-1"
        >
          <Check className="w-3 h-3" /> Accept
        </button>
        <button
          onClick={() => setEditing((v) => !v)}
          className="px-2 text-[10px] py-1 rounded bg-bg-elevated text-text-secondary hover:text-text-primary flex items-center justify-center gap-1"
        >
          <Edit3 className="w-3 h-3" /> Edit
        </button>
        <button
          onClick={() => resolve('ignore')}
          className="flex-1 text-[10px] py-1 rounded bg-bg-elevated text-text-secondary hover:text-text-primary flex items-center justify-center gap-1"
        >
          <X className="w-3 h-3" /> Ignore
        </button>
      </div>
    </div>
  );
}

// ── Create dialog ───────────────────────────────────────────────────────────

function CreateNodeDialog({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState<BrainNodeType>('idea');
  const [summary, setSummary] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!title.trim()) {
      setError('title required');
      return;
    }
    const res = await window.api.brain.createNode({
      title,
      type,
      summary,
      content,
      tags: tags.split(',').map((s) => s.trim()).filter(Boolean),
      source: { kind: 'manual' },
    });
    if (!res.ok) {
      setError(res.error || 'failed');
      return;
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm flex items-center justify-center">
      <div className="w-full max-w-md bg-bg-panel border border-bg-border rounded-lg shadow-2xl">
        <div className="px-4 py-2 border-b border-bg-border text-sm font-medium">
          New Brain note
        </div>
        <div className="p-4 space-y-3">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title"
            className="input text-xs"
          />
          <select
            value={type}
            onChange={(e) => setType(e.target.value as BrainNodeType)}
            className="input text-xs"
          >
            {BRAIN_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Summary"
            rows={2}
            className="input text-xs resize-none"
          />
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Content (markdown ok)"
            rows={6}
            className="input text-xs resize-none font-mono"
          />
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="tags, comma-separated"
            className="input text-xs font-mono"
          />
          {error && <div className="text-xs text-rose-400">{error}</div>}
        </div>
        <div className="px-4 py-2 border-t border-bg-border flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost text-xs">
            Cancel
          </button>
          <button onClick={submit} className="btn-primary text-xs">
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
