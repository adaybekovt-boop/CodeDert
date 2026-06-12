import { useEffect, useMemo, useState, useCallback, type CSSProperties } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useInternalNode,
  type Edge as RFEdge,
  type Node as RFNode,
  type InternalNode,
  Handle,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Network, RefreshCw, Folder, FolderOpen, FileCode, ChevronRight } from 'lucide-react';
import { useStore, type ProjectMapGraph, type ProjectMapNode } from '../hooks/useStore';

/**
 * Project Map — a "neural" view of the project.
 *
 * The root sits at the centre; clicking a folder fires its children outward
 * as dendrites in a radial fan. Nothing under an unexpanded folder is drawn,
 * so even huge projects stay readable — you grow the brain branch by branch.
 *
 * Connections are living filaments: a soft thread with a bright pulse that
 * travels source→child, the phase offset by depth so a wave of "firing"
 * ripples out from the centre, like signal propagation across neurons.
 *
 * Layout + edge geometry are pure geometry (radial coords + rectangle
 * intersection). No physics, no per-frame JS — the motion is SVG-native.
 */

const R0 = 200;          // radius of the first ring (root's children)
const R_STEP = 260;      // radius added per deeper ring
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

interface Placed {
  x: number;
  y: number;
  depth: number;
}

/**
 * Radial dendrite layout over the *visible* (expanded) subtree. Each node
 * owns an angular wedge sized by how many leaves hang beneath it, so busy
 * branches get room and nothing collides. Returns top-left-ish positions
 * (centred well enough — the floating edges measure real node boxes).
 */
function layoutVisible(
  index: TreeIndex,
  expanded: Set<string>
): { positions: Map<string, Placed>; visible: ProjectMapNode[] } {
  const positions = new Map<string, Placed>();
  const visible: ProjectMapNode[] = [];

  const visibleKids = (node: ProjectMapNode): ProjectMapNode[] =>
    node.kind === 'folder' && expanded.has(node.id) ? index.childrenOf.get(node.id) || [] : [];

  function leaves(id: string): number {
    const node = index.byId.get(id);
    if (!node) return 1;
    const kids = visibleKids(node);
    if (kids.length === 0) return 1;
    let sum = 0;
    for (const k of kids) sum += leaves(k.id);
    return sum;
  }

  function place(id: string, depth: number, a0: number, a1: number) {
    const node = index.byId.get(id);
    if (!node) return;
    visible.push(node);

    const angle = (a0 + a1) / 2;
    const radius = depth === 0 ? 0 : R0 + (depth - 1) * R_STEP;
    positions.set(id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, depth });

    const kids = visibleKids(node);
    if (kids.length === 0) return;

    const total = kids.reduce((s, k) => s + leaves(k.id), 0) || 1;
    // Pad each wedge slightly so sibling branches breathe apart.
    const pad = depth === 0 ? 0 : (a1 - a0) * 0.05;
    const span = a1 - a0 - pad * 2;
    let cur = a0 + pad;
    for (const k of kids) {
      const frac = leaves(k.id) / total;
      place(k.id, depth + 1, cur, cur + span * frac);
      cur += span * frac;
    }
  }

  place(index.rootId, 0, -Math.PI / 2, Math.PI * 1.5);
  return { positions, visible };
}

// ── Neural floating edge ─────────────────────────────────────
// Center-to-center geometry so threads stay clean at any angle.

function nodeCenter(node: InternalNode) {
  const p = node.internals.positionAbsolute;
  return {
    x: p.x + (node.measured?.width ?? 0) / 2,
    y: p.y + (node.measured?.height ?? 0) / 2,
  };
}

/** Where the line toward `other` exits `node`'s rectangle border. */
function borderPoint(node: InternalNode, other: InternalNode) {
  const w = (node.measured?.width ?? 0) / 2;
  const h = (node.measured?.height ?? 0) / 2;
  const c = nodeCenter(node);
  const o = nodeCenter(other);
  if (w === 0 || h === 0) return c;
  const xx1 = (o.x - c.x) / (2 * w) - (o.y - c.y) / (2 * h);
  const yy1 = (o.x - c.x) / (2 * w) + (o.y - c.y) / (2 * h);
  const a = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1);
  const xx3 = a * xx1;
  const yy3 = a * yy1;
  return { x: 2 * w * (xx3 + yy3) + c.x, y: 2 * h * (-xx3 + yy3) + c.y };
}

function NeuralEdge({
  source,
  target,
  data,
}: {
  source: string;
  target: string;
  data?: { depth?: number; kind?: 'file' | 'folder' };
}) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!sourceNode || !targetNode) return null;

  const s = borderPoint(sourceNode, targetNode);
  const t = borderPoint(targetNode, sourceNode);

  // Gentle perpendicular bow → organic dendrite instead of a ruler line.
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const bow = Math.min(46, len * 0.14);
  const cx = (s.x + t.x) / 2 + nx * bow;
  const cy = (s.y + t.y) / 2 + ny * bow;
  const path = `M${s.x},${s.y} Q${cx},${cy} ${t.x},${t.y}`;

  const isFolder = data?.kind === 'folder';
  const depth = data?.depth ?? 0;
  // Negative begin → the pulse is already mid-flight at t=0 (no dot parked at
  // the origin). Phase by depth makes the firing wave ripple outward.
  const begin = `-${((depth * 0.4) % 2.8).toFixed(2)}s`;

  return (
    <g className="neural-edge">
      <path
        d={path}
        fill="none"
        stroke="rgba(255,255,255,0.04)"
        strokeWidth={isFolder ? 7 : 5}
        strokeLinecap="round"
      />
      <path
        d={path}
        fill="none"
        stroke={isFolder ? 'rgba(255,255,255,0.32)' : 'rgba(255,255,255,0.15)'}
        strokeWidth={isFolder ? 1.4 : 1}
        strokeLinecap="round"
      />
      {/* travelling signal: soft halo + bright core, locked in phase */}
      <circle r={isFolder ? 7 : 5.5} fill="rgba(255,255,255,0.18)" className="neural-halo">
        <animateMotion dur="2.8s" begin={begin} repeatCount="indefinite" path={path} />
      </circle>
      <circle r={isFolder ? 2.6 : 2} fill="#ffffff" className="neural-core">
        <animateMotion dur="2.8s" begin={begin} repeatCount="indefinite" path={path} />
      </circle>
    </g>
  );
}

// ── Custom node renderers ────────────────────────────────────

/** Deterministic stagger so the node breathing also drifts across the map. */
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
      className={`group rounded-full flex items-center gap-2 cursor-pointer select-none transition-transform hover:scale-[1.05] map-node-anim glass-node ${
        isRoot || expanded ? 'glass-node--bright' : ''
      } ${isRoot ? 'px-6 py-3.5' : 'px-4 py-2.5'}`}
      style={{ '--pulse-delay': pulseDelay(node.id) } as CSSProperties}
    >
      <Handle type="target" position={Position.Left} className="!opacity-0 !border-0" />
      <Icon
        className={isRoot ? 'w-5 h-5 text-white/90' : 'w-4 h-4 text-white/70'}
        strokeWidth={1.5}
      />
      <div className="min-w-0">
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
      <Handle type="source" position={Position.Right} className="!opacity-0 !border-0" />
    </div>
  );
}

function FileNode({ data }: { data: { node: ProjectMapNode } }) {
  const { node } = data;
  const hasPreview = !!node.preview;
  return (
    <div
      className="rounded-2xl glass-node hover:scale-[1.03] transition-transform map-node-anim overflow-hidden"
      style={{ width: hasPreview ? FILE_W : 150, '--pulse-delay': pulseDelay(node.id) } as CSSProperties}
    >
      <Handle type="target" position={Position.Left} className="!opacity-0 !border-0" />
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-white/[0.08]">
        <FileCode className="w-3 h-3 text-zinc-500 shrink-0" strokeWidth={1.5} />
        <span className="text-[11px] text-zinc-200 truncate font-mono">{node.name}</span>
      </div>
      {hasPreview && (
        <pre className="px-2.5 py-1.5 text-[9px] leading-tight text-zinc-500 font-mono overflow-hidden max-h-[60px]">
          {node.preview}
        </pre>
      )}
      <Handle type="source" position={Position.Right} className="!opacity-0 !border-0" />
    </div>
  );
}

const nodeTypes = {
  folder: FolderNode,
  file: FileNode,
};

const edgeTypes = {
  neural: NeuralEdge,
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
      const p = positions.get(n.id);
      rEdges.push({
        id: `e:${n.id}`,
        source: n.parentId,
        target: n.id,
        type: 'neural',
        data: { depth: p?.depth ?? 0, kind: n.kind },
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

      <div className="flex-1 relative" style={{ background: 'radial-gradient(ellipse at center, rgba(255, 255, 255, 0.04) 0%, rgba(0, 0, 0, 0) 65%)' }}>
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
            edgeTypes={edgeTypes}
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
            <Background color="#3f3f46" gap={32} size={1} style={{ opacity: 0.2 }} />
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
