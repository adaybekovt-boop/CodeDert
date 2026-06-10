/**
 * Renderer-side mirrors of the main-process Brain types.
 * Kept structurally identical to `electron/services/brain.ts` exports.
 */

export type BrainNodeType =
  | 'idea'
  | 'project'
  | 'architecture'
  | 'bug'
  | 'workflow'
  | 'decision'
  | 'warning'
  | 'concept'
  | 'memory'
  | 'task'
  | 'prompt'
  | 'code_pattern'
  | 'worklog';

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
  position?: { x: number; y: number } | null;
  /** Which project this node belongs to (workspace path id). Empty = global. */
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

export interface ScoredBrainNode {
  node: BrainNode;
  score: number;
  via: 'match' | 'neighbor' | 'pinned';
}

export const BRAIN_TYPE_COLORS: Record<BrainNodeType, string> = {
  idea: '#60a5fa', // blue
  project: '#a78bfa', // violet
  architecture: '#22d3ee', // cyan
  bug: '#f87171', // red
  workflow: '#facc15', // amber
  decision: '#34d399', // emerald
  warning: '#fb923c', // orange
  concept: '#c084fc', // purple
  memory: '#94a3b8', // slate
  task: '#38bdf8', // sky
  prompt: '#fbbf24', // yellow
  code_pattern: '#84cc16', // lime
  worklog: '#10b981', // green — "what was done"
};

export const BRAIN_TYPES: BrainNodeType[] = [
  'idea',
  'project',
  'architecture',
  'bug',
  'workflow',
  'decision',
  'warning',
  'concept',
  'memory',
  'task',
  'prompt',
  'code_pattern',
  'worklog',
];
