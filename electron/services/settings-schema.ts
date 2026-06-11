/**
 * Typed, validated settings. Persisted via electron-store under key 'app'.
 * Renderer reads/writes via `window.api.appSettings.*`.
 *
 * Safety invariant: hard rules (allowDestructiveTerminal, allowEnvEdits,
 * sequentialLocalModels) cannot be disabled via this surface. The schema
 * accepts them but `normalizeAppSettings` clamps them to safe values.
 *
 * NOTE: Two fields are intentionally not user-toggleable:
 *   - sequentialLocalModels (always true)
 *   - allowDestructiveTerminal (always false — no terminal exec wired yet)
 */

export interface ProviderConfig {
  baseUrl: string;
  /** Auto-launch Ollama on app startup if it isn't running. */
  autoStart: boolean;
}

export interface SdProviderConfig {
  /** AUTOMATIC1111 API base URL. */
  baseUrl: string;
  /** Auto-launch the webui on app startup if it isn't running. */
  autoStart: boolean;
  /** Path to the stable-diffusion webui folder. '' = auto-detect. */
  webuiPath: string;
}

export interface ModelDefaults {
  chat: string;
  coder: string;
  planner: string;
  critic: string;
  reviewer: string;
}

export interface AgentSafety {
  requireApprovalForEdits: boolean;
  maxToolCalls: number;
  maxFilesPerTask: number;
  maxEditBytes: number;
  allowEnvEdits: boolean;
  protectedGlobs: string[];
  /** Opt-in master switch for the `run_command` tool. */
  allowTerminal: boolean;
  /** When true, every command spawns an approval prompt before running. */
  requireApprovalForCommands: boolean;
  terminalTimeoutMs: number;
  terminalMaxOutputBytes: number;
}

export interface WorkspacePolicy {
  ignoredFolders: string[];
  maxFileBytes: number;
  includeTests: boolean;
  includeConfigs: boolean;
  includeHidden: boolean;
}

export interface PerformancePolicy {
  streamThrottleMs: number;
  maxChatHistory: number;
  maxRenderedMessages: number;
  maxContextBytes: number;
  scanConcurrency: number;
}

export interface ModelTuning {
  temperature: number;
  maxOutputTokens: number;
  contextWindow: number;
  keepAliveSeconds: number;
}

export interface BrainPolicy {
  enabled: boolean;
  autoCapture: boolean;
  /** Auto-record a "what was done" worklog entry after each completed task. */
  autoWorklog: boolean;
  /** Scope brain notes + worklog to the active project (workspace). */
  scopeToProject: boolean;
  requireReview: boolean;
  minConfidence: number;
  maxSuggestionsPerConversation: number;
  maxInjectedNodes: number;
  injectRelevantNotes: boolean;
  allowAutoLinking: boolean;
  dedupSimilarityThreshold: number;
  protectedTags: string[];
  ignoredSources: string[];
}

export interface McpServerConfig {
  /** Unique display name, e.g. "filesystem". */
  name: string;
  /** Executable / launcher, e.g. "npx". */
  command: string;
  args: string[];
  /** Off by default — the user must explicitly enable each server. */
  enabled: boolean;
}

export interface McpPolicy {
  servers: McpServerConfig[];
}

export interface AppSettings {
  provider: { ollama: ProviderConfig; sd: SdProviderConfig };
  models: ModelDefaults;
  tuning: ModelTuning;
  agent: AgentSafety;
  workspace: WorkspacePolicy;
  performance: PerformancePolicy;
  brain: BrainPolicy;
  mcp: McpPolicy;
  /** Always true — exposed read-only for diagnostics. */
  sequentialLocalModels: boolean;
  /** Always false — terminal exec is not implemented; placeholder for future. */
  allowDestructiveTerminal: boolean;
}

export const DEFAULT_PROTECTED_GLOBS = [
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  '**/id_rsa',
  '**/id_ed25519',
  '**/*.pem',
  '**/secrets.*',
];

export const DEFAULT_IGNORED_FOLDERS = [
  'node_modules',
  '.git',
  '.next',
  'dist',
  'dist-electron',
  'release',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
  'out',
  'build',
  '.turbo',
  'coverage',
];

export const DEFAULT_APP_SETTINGS: AppSettings = {
  provider: {
    ollama: { baseUrl: 'http://localhost:11434', autoStart: true },
    sd: { baseUrl: 'http://localhost:7860', autoStart: false, webuiPath: '' },
  },
  models: {
    chat: '',
    coder: 'qwen3-coder:30b',
    planner: 'deepseek-r1:32b',
    critic: 'gemma4:26b',
    reviewer: 'gemma4:26b',
  },
  tuning: {
    temperature: 0.2,
    maxOutputTokens: 2048,
    contextWindow: 16000,
    keepAliveSeconds: 0,
  },
  agent: {
    requireApprovalForEdits: false,
    maxToolCalls: 12,
    maxFilesPerTask: 24,
    maxEditBytes: 200_000,
    allowEnvEdits: false,
    protectedGlobs: DEFAULT_PROTECTED_GLOBS,
    allowTerminal: false,
    requireApprovalForCommands: true,
    terminalTimeoutMs: 60_000,
    terminalMaxOutputBytes: 200_000,
  },
  workspace: {
    ignoredFolders: DEFAULT_IGNORED_FOLDERS,
    maxFileBytes: 5 * 1024 * 1024,
    includeTests: true,
    includeConfigs: true,
    includeHidden: false,
  },
  performance: {
    streamThrottleMs: 50,
    maxChatHistory: 200,
    maxRenderedMessages: 60,
    maxContextBytes: 120_000,
    scanConcurrency: 8,
  },
  brain: {
    enabled: true,
    autoCapture: true,
    autoWorklog: true,
    scopeToProject: true,
    requireReview: true,
    minConfidence: 0.6,
    maxSuggestionsPerConversation: 5,
    maxInjectedNodes: 5,
    injectRelevantNotes: true,
    allowAutoLinking: true,
    dedupSimilarityThreshold: 0.7,
    protectedTags: ['secret', 'credential'],
    ignoredSources: [],
  },
  mcp: { servers: [] },
  sequentialLocalModels: true,
  allowDestructiveTerminal: false,
};

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function clampFloat(n: unknown, min: number, max: number, fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function strArr(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out.length > 0 ? out : fallback;
}

function str(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  return v.trim() || fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  return fallback;
}

export function normalizeAppSettings(input: unknown): AppSettings {
  const i = (input ?? {}) as Partial<AppSettings>;
  const D = DEFAULT_APP_SETTINGS;

  return {
    provider: {
      ollama: {
        baseUrl: str(i.provider?.ollama?.baseUrl, D.provider.ollama.baseUrl),
        autoStart: bool(i.provider?.ollama?.autoStart, D.provider.ollama.autoStart),
      },
      sd: {
        baseUrl: str(i.provider?.sd?.baseUrl, D.provider.sd.baseUrl),
        // Hard invariant: the SD webui never auto-starts (heavy GPU process,
        // minutes of boot). Launch is manual-only via the image panel button.
        autoStart: false,
        webuiPath: str(i.provider?.sd?.webuiPath, D.provider.sd.webuiPath),
      },
    },
    models: {
      chat: str(i.models?.chat, D.models.chat),
      coder: str(i.models?.coder, D.models.coder),
      planner: str(i.models?.planner, D.models.planner),
      critic: str(i.models?.critic, D.models.critic),
      reviewer: str(i.models?.reviewer, D.models.reviewer),
    },
    tuning: {
      temperature: clampFloat(i.tuning?.temperature, 0, 2, D.tuning.temperature),
      maxOutputTokens: clamp(i.tuning?.maxOutputTokens, 64, 32768, D.tuning.maxOutputTokens),
      contextWindow: clamp(i.tuning?.contextWindow, 1024, 200_000, D.tuning.contextWindow),
      keepAliveSeconds: clamp(i.tuning?.keepAliveSeconds, 0, 3600, D.tuning.keepAliveSeconds),
    },
    agent: {
      requireApprovalForEdits: bool(i.agent?.requireApprovalForEdits, D.agent.requireApprovalForEdits),
      maxToolCalls: clamp(i.agent?.maxToolCalls, 1, 50, D.agent.maxToolCalls),
      maxFilesPerTask: clamp(i.agent?.maxFilesPerTask, 1, 200, D.agent.maxFilesPerTask),
      maxEditBytes: clamp(i.agent?.maxEditBytes, 1024, 5_000_000, D.agent.maxEditBytes),
      allowEnvEdits: bool(i.agent?.allowEnvEdits, D.agent.allowEnvEdits),
      protectedGlobs: strArr(i.agent?.protectedGlobs, D.agent.protectedGlobs),
      allowTerminal: bool(i.agent?.allowTerminal, D.agent.allowTerminal),
      requireApprovalForCommands: bool(
        i.agent?.requireApprovalForCommands,
        D.agent.requireApprovalForCommands
      ),
      terminalTimeoutMs: clamp(
        i.agent?.terminalTimeoutMs,
        1000,
        30 * 60 * 1000,
        D.agent.terminalTimeoutMs
      ),
      terminalMaxOutputBytes: clamp(
        i.agent?.terminalMaxOutputBytes,
        1024,
        5_000_000,
        D.agent.terminalMaxOutputBytes
      ),
    },
    workspace: {
      ignoredFolders: strArr(i.workspace?.ignoredFolders, D.workspace.ignoredFolders),
      maxFileBytes: clamp(i.workspace?.maxFileBytes, 1024, 100 * 1024 * 1024, D.workspace.maxFileBytes),
      includeTests: bool(i.workspace?.includeTests, D.workspace.includeTests),
      includeConfigs: bool(i.workspace?.includeConfigs, D.workspace.includeConfigs),
      includeHidden: bool(i.workspace?.includeHidden, D.workspace.includeHidden),
    },
    performance: {
      streamThrottleMs: clamp(i.performance?.streamThrottleMs, 0, 1000, D.performance.streamThrottleMs),
      maxChatHistory: clamp(i.performance?.maxChatHistory, 10, 5000, D.performance.maxChatHistory),
      maxRenderedMessages: clamp(i.performance?.maxRenderedMessages, 10, 1000, D.performance.maxRenderedMessages),
      maxContextBytes: clamp(i.performance?.maxContextBytes, 4_000, 1_000_000, D.performance.maxContextBytes),
      scanConcurrency: clamp(i.performance?.scanConcurrency, 1, 32, D.performance.scanConcurrency),
    },
    brain: {
      enabled: bool(i.brain?.enabled, D.brain.enabled),
      autoCapture: bool(i.brain?.autoCapture, D.brain.autoCapture),
      autoWorklog: bool(i.brain?.autoWorklog, D.brain.autoWorklog),
      scopeToProject: bool(i.brain?.scopeToProject, D.brain.scopeToProject),
      requireReview: bool(i.brain?.requireReview, D.brain.requireReview),
      minConfidence: clampFloat(i.brain?.minConfidence, 0, 1, D.brain.minConfidence),
      maxSuggestionsPerConversation: clamp(
        i.brain?.maxSuggestionsPerConversation,
        0,
        50,
        D.brain.maxSuggestionsPerConversation
      ),
      maxInjectedNodes: clamp(i.brain?.maxInjectedNodes, 0, 50, D.brain.maxInjectedNodes),
      injectRelevantNotes: bool(i.brain?.injectRelevantNotes, D.brain.injectRelevantNotes),
      allowAutoLinking: bool(i.brain?.allowAutoLinking, D.brain.allowAutoLinking),
      dedupSimilarityThreshold: clampFloat(
        i.brain?.dedupSimilarityThreshold,
        0,
        1,
        D.brain.dedupSimilarityThreshold
      ),
      protectedTags: strArr(i.brain?.protectedTags, D.brain.protectedTags),
      ignoredSources: strArr(i.brain?.ignoredSources, D.brain.ignoredSources),
    },
    mcp: { servers: normalizeMcpServers(i.mcp?.servers) },
    // Hard invariants — cannot be changed via settings.
    sequentialLocalModels: true,
    allowDestructiveTerminal: false,
  };
}

function normalizeMcpServers(v: unknown): McpServerConfig[] {
  if (!Array.isArray(v)) return [];
  const out: McpServerConfig[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const name = typeof (item as any).name === 'string' ? (item as any).name.trim().slice(0, 64) : '';
    const command = typeof (item as any).command === 'string' ? (item as any).command.trim().slice(0, 1024) : '';
    if (!name || !command || seen.has(name)) continue;
    seen.add(name);
    const argsRaw = (item as any).args;
    const args = Array.isArray(argsRaw)
      ? argsRaw.filter((a: unknown) => typeof a === 'string').map((a: string) => a.slice(0, 1024)).slice(0, 32)
      : [];
    out.push({ name, command, args, enabled: (item as any).enabled === true });
    if (out.length >= 16) break;
  }
  return out;
}
