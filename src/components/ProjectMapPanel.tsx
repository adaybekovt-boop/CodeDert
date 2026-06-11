import { useEffect, useMemo, useState } from 'react';
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
import { Network, RefreshCw, Folder, FileCode } from 'lucide-react';
import { useStore, type ProjectMapGraph, type ProjectMapNode } from '../hooks/useStore';

/**
 * Project Map — brain-style visualization of the workspace.
 *
 * Layout: hierarchical radial. The root sits at (0,0). Each child folder gets
 * its own angular sector, children orbit their parent at increasing radius.
 * Layout is computed ONCE per graph (memoized) — no physics, no per-frame work.
 *
 * Performance choices:
 *  - viewport-only rendering (ReactFlow default)
 *  - simple CSS-only entrance animation (1 transform per node)
 *  - no minimap on big graphs (>120 nodes)
 *  - no edge animation past 80 nodes
 */

const RADIUS_BASE = 260;
const RADIUS_STEP = 220;

interface LaidOutNode {
  id: string;
  x: number;
  y: number;
  data: ProjectMapNode;
  depth: number;
}

function layoutGraph(graph: ProjectMapGraph): {
  nodes: LaidOutNode[];
  edges: { from: string; to: string }[];
} {
  if (!graph || graph.nodes.length === 0) return { nodes: [], edges: [] };

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, string[]>();
  for (const e of graph.edges) {
    const arr = childrenOf.get(e.from) || [];
    arr.push(e.to);
    childrenOf.set(e.from, arr);
  }

  const root = graph.nodes.find((n) => n.parentId === null) || graph.nodes[0];
  const positions = new Map<string, { x: number; y: number; depth: number }>();
  positions.set(root.id, { x: 0, y: 0, depth: 0 });

  // BFS, each level placed in a circular ring around its parent's sector.
  type QItem = { id: string; angleStart: number; angleEnd: number; depth: number };
  const queue: QItem[] = [{ id: root.id, angleStart: 0, angleEnd: Math.PI * 2, depth: 0 }];

  while (queue.length > 0) {
    const { id, angleStart, angleEnd, depth } = queue.shift()!;
    const children = childrenOf.get(id) || [];
    if (children.length === 0) continue;

    // Sort: folders first (so they cluster), then files.
    children.sort((a, b) => {
      const na = byId.get(a)!;
      const nb = byId.get(b)!;
      if (na.kind !== nb.kind) return na.kind === 'folder' ? -1 : 1;
      return na.name.localeCompare(nb.name);
    });

    const parentPos = positions.get(id)!;
    const radius = RADIUS_BASE + RADIUS_STEP * depth;
    const sector = angleEnd - angleStart;
    const step = sector / children.length;

    children.forEach((cid, i) => {
      const angle = angleStart + step * (i + 0.5);
      const cx = parentPos.x + Math.cos(angle) * radius;
      const cy = parentPos.y + Math.sin(angle) * radius;
      positions.set(cid, { x: cx, y: cy, depth: depth + 1 });
      // Give each child a narrower sector centered on its angle for the next level.
      const childSector = step * 0.85;
      queue.push({
        id: cid,
        angleStart: angle - childSector / 2,
        angleEnd: angle + childSector / 2,
        depth: depth + 1,
      });
    });
  }

  const laidOut: LaidOutNode[] = [];
  for (const n of graph.nodes) {
    const p = positions.get(n.id);
    if (!p) continue;
    laidOut.push({ id: n.id, x: p.x, y: p.y, data: n, depth: p.depth });
  }
  return { nodes: laidOut, edges: graph.edges };
}

// ── Custom node renderers ────────────────────────────────────

function FolderNode({ data }: { data: { node: ProjectMapNode; depth: number } }) {
  const { node, depth } = data;
  const isRoot = node.parentId === null;
  const size = isRoot ? 'min-w-[160px] px-5 py-3' : 'min-w-[120px] px-4 py-2.5';
  return (
    <div
      className={`group rounded-2xl backdrop-blur-sm border shadow-lg flex items-center gap-2 ${size} animate-mapNodeIn`}
      style={{
        background: isRoot
          ? 'linear-gradient(135deg, rgba(139, 92, 246, 0.25), rgba(99, 102, 241, 0.15))'
          : `linear-gradient(135deg, rgba(99, 102, 241, ${0.18 - depth * 0.02}), rgba(139, 92, 246, ${0.10 - depth * 0.01}))`,
        borderColor: isRoot ? 'rgba(167, 139, 250, 0.6)' : 'rgba(129, 140, 248, 0.35)',
        boxShadow: isRoot
          ? '0 0 32px rgba(139, 92, 246, 0.35), 0 4px 16px rgba(0,0,0,0.3)'
          : '0 0 18px rgba(99, 102, 241, 0.2), 0 2px 8px rgba(0,0,0,0.25)',
      }}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Folder
        className={isRoot ? 'w-5 h-5 text-violet-300' : 'w-4 h-4 text-indigo-300'}
        strokeWidth={1.5}
      />
      <div className="flex-1 min-w-0">
        <div className={`font-medium truncate ${isRoot ? 'text-base text-white' : 'text-sm text-slate-100'}`}>
          {node.name}
        </div>
        {node.childCount ? (
          <div className="text-[10px] text-slate-400">{node.childCount} элем.</div>
        ) : null}
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

function FileNode({ data }: { data: { node: ProjectMapNode } }) {
  const { node } = data;
  const hasPreview = !!node.preview;
  return (
    <div
      className="rounded-xl backdrop-blur-sm border bg-slate-900/70 border-slate-700/60 shadow-md hover:border-indigo-400/60 hover:shadow-indigo-500/20 transition-colors animate-mapNodeIn"
      style={{ width: hasPreview ? 220 : 150 }}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-slate-700/50">
        <FileCode className="w-3 h-3 text-slate-400 shrink-0" strokeWidth={1.5} />
        <span className="text-[11px] text-slate-200 truncate font-mono">{node.name}</span>
      </div>
      {hasPreview && (
        <pre className="px-2.5 py-1.5 text-[9px] leading-tight text-slate-400/90 font-mono overflow-hidden max-h-[60px]">
          {node.preview}
        </pre>
      )}
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
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

  // Auto-load if we have a workspace but no graph yet.
  useEffect(() => {
    if (workspaceRoot && !projectMapGraph && !projectMapLoading) {
      refreshProjectMap();
    }
  }, [workspaceRoot, projectMapGraph, projectMapLoading, refreshProjectMap]);

  const { nodes: rfNodes, edges: rfEdges } = useMemo(() => {
    if (!projectMapGraph) return { nodes: [] as RFNode[], edges: [] as RFEdge[] };
    const { nodes, edges } = layoutGraph(projectMapGraph);
    const animateEdges = nodes.length <= 80;
    const rNodes: RFNode[] = nodes.map((n) => ({
      id: n.id,
      type: n.data.kind === 'folder' ? 'folder' : 'file',
      position: { x: n.x, y: n.y },
      data: { node: n.data, depth: n.depth },
      draggable: true,
    }));
    const rEdges: RFEdge[] = edges.map((e, i) => ({
      id: `e${i}`,
      source: e.from,
      target: e.to,
      type: 'bezier',
      animated: animateEdges,
      style: {
        stroke: 'rgba(139, 92, 246, 0.35)',
        strokeWidth: 1,
      },
    }));
    return { nodes: rNodes, edges: rEdges };
  }, [projectMapGraph]);

  if (!workspaceRoot) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-text-secondary gap-3">
        <Network className="w-12 h-12 opacity-30" strokeWidth={1} />
        <div>Откройте проект, чтобы увидеть его карту</div>
      </div>
    );
  }

  const nodeCount = projectMapGraph?.nodes.length || 0;
  const showMini = nodeCount > 0 && nodeCount <= 120;

  return (
    <div className="flex-1 flex flex-col bg-bg min-h-0">
      <div className="px-4 py-2 border-b border-bg-border flex items-center gap-3 bg-bg-panel/50">
        <Network className="w-4 h-4 text-violet-400" strokeWidth={1.5} />
        <div className="text-sm font-medium text-text-primary">Карта проекта</div>
        {projectMapGraph && (
          <div className="text-xs text-text-secondary">
            {projectMapGraph.rootName} · {nodeCount} узл.
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

      <div className="flex-1 relative" style={{ background: 'radial-gradient(ellipse at center, rgba(76, 29, 149, 0.08) 0%, rgba(15, 23, 42, 0) 70%)' }}>
        {projectMapLoading && !projectMapGraph ? (
          <div className="absolute inset-0 flex items-center justify-center text-text-secondary">
            Строим карту проекта…
          </div>
        ) : nodeCount === 0 ? (
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
            onNodeMouseEnter={(_, n) => setHoverInfo((n.data as any).node)}
            onNodeMouseLeave={() => setHoverInfo(null)}
          >
            <Background color="#4c1d95" gap={32} size={1} style={{ opacity: 0.15 }} />
            <Controls className="!bg-bg-panel !border-bg-border" />
            {showMini && (
              <MiniMap
                pannable
                zoomable
                className="!bg-bg-panel !border-bg-border"
                nodeColor={(n) => (n.type === 'folder' ? '#8b5cf6' : '#475569')}
                maskColor="rgba(15, 23, 42, 0.6)"
              />
            )}
          </ReactFlow>
        )}

        {hoverInfo && hoverInfo.preview && (
          <div className="absolute bottom-4 left-4 right-4 max-h-32 overflow-hidden rounded-lg border border-bg-border bg-bg-panel/95 backdrop-blur-sm p-3 shadow-xl pointer-events-none">
            <div className="text-[11px] font-mono text-violet-300 mb-1">{hoverInfo.relPath}</div>
            <pre className="text-[10px] text-slate-300 font-mono overflow-hidden whitespace-pre-wrap">
              {hoverInfo.preview}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
