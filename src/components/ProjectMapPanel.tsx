import { useEffect, useMemo, useState, useCallback, type CSSProperties } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge as RFEdge,
  type Node as RFNode,
  Handle,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Network, RefreshCw, Folder, FolderOpen, FileCode, ChevronRight } from 'lucide-react';
import { useStore, type ProjectMapGraph, type ProjectMapNode } from '../hooks/useStore';

/**
 * Project Map — interactive folder-tree visualization.
 *
 * Hierarchy-first: the root folder sits on the left; clicking a folder
 * expands its children (subfolders + files) as a branch to the right —
 * mindmap style. Nothing below an unexpanded folder is rendered, so even
 * huge projects stay light.
 *
 * Layout: tidy left-to-right tree. x = depth * COL_W; y is assigned by
 * leaf-counting so parents sit centered against their children. Computed
 * in a single useMemo pass — no physics, no per-frame work.
 */

const COL_W = 320;       // horizontal distance between depth levels
const ROW_H = 92;        // vertical distance between sibling leaves
const FILE_W = 220;

interface TreeIndex {
  byId: Map<string, ProjectMapNode>;
  childrenOf: Map<string, ProjectMapNode[]>;
  rootId: string;
}

function buildIndex(graph: ProjectMapGraph): TreeIndex {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, ProjectMapNode[]>();
  for (const n of graph.nodes) {
    if (!n.parentId) continue;
    const arr = childrenOf.get(n.parentId) || [];
    arr.push(n);
    childrenOf.set(n.parentId, arr);
  }
  // Folders first, then files, both alphabetical — stable branch order.
  for (const arr of childrenOf.values()) {
    arr.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }
  const root = graph.nodes.find((n) => n.parentId === null) || graph.nodes[0];
  return { byId, childrenOf, rootId: root.id };
}

/**
 * Lay out only the visible subtree (expanded folders). Returns positions
 * keyed by node id. Classic tidy tree: leaves get sequential rows, every
 * parent is centered over its visible children.
 */
function layoutVisible(
  index: TreeIndex,
  expanded: Set<string>
): { positions: Map<string, { x: number; y: number; depth: number }>; visible: ProjectMapNode[] } {
  const positions = new Map<string, { x: number; y: number; depth: number }>();
  const visible: ProjectMapNode[] = [];
  let nextRow = 0;

  function place(id: string, depth: number): number {
    const node = index.byId.get(id);
    if (!node) return nextRow * ROW_H;
    visible.push(node);

    const kids = node.kind === 'folder' && expanded.has(id) ? index.childrenOf.get(id) || [] : [];
    if (kids.length === 0) {
      const y = nextRow * ROW_H;
      nextRow += 1;
      positions.set(id, { x: depth * COL_W, y, depth });
      return y;
    }
    const childYs = kids.map((k) => place(k.id, depth + 1));
    const y = (childYs[0] + childYs[childYs.length - 1]) / 2;
    positions.set(id, { x: depth * COL_W, y, depth });
    return y;
  }

  place(index.rootId, 0);
  return { positions, visible };
}

// ── Custom node renderers ────────────────────────────────────

/** Deterministic stagger so the glow wave travels across the map. */
function pulseDelay(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return `${(Math.abs(h) % 8) * 0.45}s`;
}

function FolderNode({ data }: {
  data: { node: ProjectMapNode; depth: number; expanded: boolean };
}) {
  const { node, expanded } = data;
  const isRoot = node.parentId === null;
  const Icon = expanded ? FolderOpen : Folder;
  return (
    <div
      className={`group rounded-2xl flex items-center gap-2 cursor-pointer select-none transition-transform hover:scale-[1.03] map-node-anim glass-node ${
        isRoot || expanded ? 'glass-node--bright' : ''
      } ${isRoot ? 'min-w-[170px] px-5 py-3' : 'min-w-[130px] px-4 py-2.5'}`}
      style={{ '--pulse-delay': pulseDelay(node.id) } as CSSProperties}
    >
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <Icon
        className={isRoot ? 'w-5 h-5 text-white/90' : 'w-4 h-4 text-white/70'}
        strokeWidth={1.5}
      />
      <div className="flex-1 min-w-0">
        <div className={`font-medium truncate ${isRoot ? 'text-base text-white' : 'text-sm text-zinc-100'}`}>
          {node.name}
        </div>
        {node.childCount ? (
          <div className="text-[10px] text-zinc-500">{node.childCount} элем.</div>
        ) : null}
      </div>
      {!!node.childCount && (
        <ChevronRight
          className={`w-3.5 h-3.5 text-white/50 transition-transform ${expanded ? 'rotate-90' : ''}`}
          strokeWidth={2}
        />
      )}
      <Handle type="source" position={Position.Right} className="!opacity-0" />
    </div>
  );
}

function FileNode({ data }: { data: { node: ProjectMapNode } }) {
  const { node } = data;
  const hasPreview = !!node.preview;
  return (
    <div
      className="rounded-xl glass-node hover:scale-[1.02] transition-transform map-node-anim"
      style={{ width: hasPreview ? FILE_W : 150, '--pulse-delay': pulseDelay(node.id) } as CSSProperties}
    >
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-white/[0.08]">
        <FileCode className="w-3 h-3 text-zinc-500 shrink-0" strokeWidth={1.5} />
        <span className="text-[11px] text-zinc-200 truncate font-mono">{node.name}</span>
      </div>
      {hasPreview && (
        <pre className="px-2.5 py-1.5 text-[9px] leading-tight text-zinc-500 font-mono overflow-hidden max-h-[60px]">
          {node.preview}
        </pre>
      )}
      <Handle type="source" position={Position.Right} className="!opacity-0" />
    </div>
  );
}

const nodeTypes = {
  folder: FolderNode,
  file: FileNode,
};

// ── Panel ─────────────────────────────────────────────────────

export function ProjectMapPanel() {
  const {
    workspaceRoot,
    projectMapGraph,
    projectMapLoading,
    refreshProjectMap,
  } = useStore();
  const [hoverInfo, setHoverInfo] = useState<ProjectMapNode | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Auto-load if we have a workspace but no graph yet.
  useEffect(() => {
    if (workspaceRoot && !projectMapGraph && !projectMapLoading) {
      refreshProjectMap();
    }
  }, [workspaceRoot, projectMapGraph, projectMapLoading, refreshProjectMap]);

  const index = useMemo(
    () => (projectMapGraph && projectMapGraph.nodes.length > 0 ? buildIndex(projectMapGraph) : null),
    [projectMapGraph]
  );

  // New graph → start with just the root expanded (top-level branches visible).
  useEffect(() => {
    if (index) setExpanded(new Set([index.rootId]));
  }, [index]);

  const toggleFolder = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const { nodes: rfNodes, edges: rfEdges } = useMemo(() => {
    if (!index) return { nodes: [] as RFNode[], edges: [] as RFEdge[] };
    const { positions, visible } = layoutVisible(index, expanded);
    const animateEdges = visible.length <= 80;

    const rNodes: RFNode[] = visible.map((n) => {
      const p = positions.get(n.id)!;
      return {
        id: n.id,
        type: n.kind === 'folder' ? 'folder' : 'file',
        position: { x: p.x, y: p.y },
        data: { node: n, depth: p.depth, expanded: expanded.has(n.id) },
        draggable: true,
      };
    });

    const visibleIds = new Set(visible.map((n) => n.id));
    const rEdges: RFEdge[] = [];
    for (const n of visible) {
      if (!n.parentId || !visibleIds.has(n.parentId)) continue;
      rEdges.push({
        id: `e:${n.id}`,
        source: n.parentId,
        target: n.id,
        type: 'smoothstep',
        animated: animateEdges,
        style: {
          stroke: n.kind === 'folder' ? 'rgba(255, 255, 255, 0.30)' : 'rgba(255, 255, 255, 0.14)',
          strokeWidth: n.kind === 'folder' ? 1.5 : 1,
        },
      });
    }
    return { nodes: rNodes, edges: rEdges };
  }, [index, expanded]);

  if (!workspaceRoot) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-text-secondary gap-3">
        <Network className="w-12 h-12 opacity-30" strokeWidth={1} />
        <div>Откройте проект, чтобы увидеть его карту</div>
      </div>
    );
  }

  const visibleCount = rfNodes.length;
  const totalCount = projectMapGraph?.nodes.length || 0;
  const showMini = visibleCount > 0 && visibleCount <= 120;

  return (
    <div className="flex-1 flex flex-col bg-bg min-h-0">
      <div className="px-4 py-2 border-b border-bg-border flex items-center gap-3 bg-bg-panel/50">
        <Network className="w-4 h-4 text-zinc-300" strokeWidth={1.5} />
        <div className="text-sm font-medium text-text-primary">Карта проекта</div>
        {projectMapGraph && (
          <div className="text-xs text-text-secondary">
            {projectMapGraph.rootName} · {visibleCount}/{totalCount} узл. · клик по папке раскрывает её
          </div>
        )}
        <div className="flex-1" />
        <button
          onClick={() => refreshProjectMap()}
          disabled={projectMapLoading}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors disabled:opacity-50"
        >
          <RefreshCw
            className={`w-3 h-3 ${projectMapLoading ? 'animate-spin' : ''}`}
            strokeWidth={1.5}
          />
          Обновить
        </button>
      </div>

      <div className="flex-1 relative" style={{ background: 'radial-gradient(ellipse at center, rgba(255, 255, 255, 0.03) 0%, rgba(0, 0, 0, 0) 70%)' }}>
        {projectMapLoading && !projectMapGraph ? (
          <div className="absolute inset-0 flex items-center justify-center text-text-secondary">
            Строим карту проекта…
          </div>
        ) : totalCount === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-text-secondary">
            Карта пуста
          </div>
        ) : (
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.1}
            maxZoom={1.5}
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_, n) => {
              const data = n.data as any;
              if (data?.node?.kind === 'folder') toggleFolder(n.id);
            }}
            onNodeMouseEnter={(_, n) => setHoverInfo((n.data as any).node)}
            onNodeMouseLeave={() => setHoverInfo(null)}
          >
            <Background color="#3f3f46" gap={32} size={1} style={{ opacity: 0.25 }} />
            <Controls className="!bg-bg-panel !border-bg-border" />
            {showMini && (
              <MiniMap
                pannable
                zoomable
                className="!bg-bg-panel !border-bg-border"
                nodeColor={(n) => (n.type === 'folder' ? '#d4d4d8' : '#52525b')}
                maskColor="rgba(10, 10, 11, 0.65)"
              />
            )}
          </ReactFlow>
        )}

        {hoverInfo && hoverInfo.preview && (
          <div className="absolute bottom-4 left-4 right-4 max-h-32 overflow-hidden rounded-xl glass-node p-3 pointer-events-none">
            <div className="text-[11px] font-mono text-zinc-300 mb-1">{hoverInfo.relPath}</div>
            <pre className="text-[10px] text-zinc-400 font-mono overflow-hidden whitespace-pre-wrap">
              {hoverInfo.preview}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
