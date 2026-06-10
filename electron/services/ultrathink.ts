import type { BrowserWindow } from 'electron';
import { ollama } from './ollama.js';
import { ollamaBus } from './ollama-bus.js';
import { aiMutex } from './ai-mutex.js';
import {
  buildUltrathinkContext,
  type UltrathinkConfig,
} from './ultrathink-context-builder.js';
import {
  buildRepairPrompt,
  validateUltrathinkReport,
} from './ultrathink-validator.js';

export type UltrathinkModelChoice = 'auto' | 'deepseek' | 'gemma';

export const DEFAULT_ULTRATHINK_CONFIG: UltrathinkConfig = {
  enabled: true,
  defaultModel: 'deepseek-r1:32b',
  allowModelOverride: true,
  sequentialExecutionOnly: true,
  maxFiles: 120,
  maxFileBytes: 200000,
  maxContextTokens: 120000,
  includeTests: true,
  includeConfigs: true,
  autoUnloadModels: true,
  ignoredFolders: [],
  confidenceThreshold: 0.6,
  models: {
    deepseek: 'deepseek-r1:32b',
    gemma: 'gemma4:26b',
  },
};

interface UltrathinkSession {
  requestId: string;
  model: string;
  aborted: boolean;
}

const sessions = new Map<string, UltrathinkSession>();
let activeSessionRequestId: string | null = null;

const ULTRATHINK_SYSTEM = `You are operating in ULTRATHINK mode.

Your role:

* deeply analyze the repository and task
* reason carefully
* inspect architecture
* identify hidden assumptions
* identify risks and regressions
* investigate dependencies and control flow

You are NOT allowed to:

* modify files
* generate patches
* execute commands
* redesign the entire system unnecessarily
* hallucinate missing APIs

You must separate:
FACTS
INFERENCES
UNCERTAINTIES

Be skeptical.
Use repository evidence.
Do not guess when context is missing.`;

const REQUIRED_OUTPUT = `Return a markdown report with exactly these sections:
1. Short Answer
2. Main Finding
3. Root Cause Analysis
4. Evidence
5. Affected Files
6. Affected Functions/Classes
7. Dependency Analysis
8. Architecture Risks
9. Edge Cases
10. Security Concerns
11. Performance Concerns
12. Recommended Fix
13. Detailed Implementation Plan
14. Tests To Run
15. Unknowns / Missing Context
16. Confidence Level

Rules:
- Analysis only.
- Do not write patches.
- Do not include final code blocks for implementation.
- Evidence must cite concrete repository files.
- The implementation plan must be precise and actionable.`;

export function normalizeUltrathinkConfig(config?: Partial<UltrathinkConfig>): UltrathinkConfig {
  const merged: UltrathinkConfig = {
    ...DEFAULT_ULTRATHINK_CONFIG,
    ...config,
    sequentialExecutionOnly: true,
    autoUnloadModels: true,
    models: {
      ...DEFAULT_ULTRATHINK_CONFIG.models,
      ...(config?.models || {}),
    },
  };

  return {
    ...merged,
    maxFiles: clampInt(merged.maxFiles, 10, 240),
    maxFileBytes: clampInt(merged.maxFileBytes, 10_000, 500_000),
    maxContextTokens: clampInt(merged.maxContextTokens, 8_000, 180_000),
    confidenceThreshold: Math.max(0, Math.min(1, Number(merged.confidenceThreshold) || 0.6)),
    ignoredFolders: Array.isArray(merged.ignoredFolders) ? merged.ignoredFolders : [],
  };
}

export const ultrathink = {
  defaultConfig: DEFAULT_ULTRATHINK_CONFIG,

  async start(
    params: {
      task: string;
      workspaceRoot: string;
      requestId: string;
      modelChoice: UltrathinkModelChoice;
      config: UltrathinkConfig;
    },
    win: BrowserWindow
  ): Promise<{ ok: boolean; error?: string }> {
    const { task, workspaceRoot, requestId } = params;
    const config = normalizeUltrathinkConfig(params.config);
    const emit = (data: any) =>
      win.webContents.send('ultrathink:progress', { requestId, ...data });

    if (!config.enabled) {
      emit({ phase: 'error', message: 'ultrathink is disabled' });
      return { ok: false, error: 'disabled' };
    }
    if (activeSessionRequestId && activeSessionRequestId !== requestId) {
      emit({ phase: 'error', message: 'ultrathink already running' });
      return { ok: false, error: 'ultrathink already running' };
    }
    const lock = aiMutex.acquire('ultrathink', requestId, () => {
      ultrathink.cancel(requestId);
    });
    if (!lock.ok) {
      emit({ phase: 'error', message: lock.error || 'AI lock busy' });
      return { ok: false, error: lock.error };
    }
    if (!task.trim()) {
      emit({ phase: 'error', message: 'Usage: /ultrathink <task>' });
      lock.release?.();
      return { ok: false, error: 'empty task' };
    }
    if (!workspaceRoot) {
      emit({ phase: 'error', message: 'No project folder is open' });
      lock.release?.();
      return { ok: false, error: 'no workspace' };
    }

    activeSessionRequestId = requestId;
    const model = selectModel(task, params.modelChoice, config);
    sessions.set(requestId, { requestId, model, aborted: false });

    try {
      emit({ phase: 'start', model, message: `Ultrathink using ${model}` });
      const context = await buildUltrathinkContext(
        workspaceRoot,
        task,
        config,
        emit,
        () => isCancelled(requestId)
      );
      if (isCancelled(requestId)) throw new Error('aborted');
      emit({
        phase: 'context-ready',
        model,
        analyzedFiles: context.analyzedFiles,
        totalFiles: context.totalFiles,
        repositorySummary: context.repositorySummary,
      });

      const prompt = `${REQUIRED_OUTPUT}

User task:
${task}

Repository context:
${context.text}`;

      emit({ phase: 'reasoning', model, message: `${model} analyzing repository...` });
      let report = await runUltrathinkStage(model, prompt, requestId, win);
      if (isCancelled(requestId)) throw new Error('aborted');
      let validation = validateUltrathinkReport(report.text, config.confidenceThreshold);

      if (!report.ok) {
        lock.release?.();
        return fail(requestId, report.error || 'model failed', emit, model);
      }
      await ollama.unload(model);

      if (!validation.ok) {
        emit({ phase: 'repair', model, message: 'Repairing malformed analysis report...' });
        const repair = await runUltrathinkStage(
          model,
          buildRepairPrompt(report.text, validation.issues),
          requestId,
          win,
          'repair'
        );
        if (isCancelled(requestId)) throw new Error('aborted');
        if (!repair.ok) {
          lock.release?.();
          return fail(requestId, repair.error || 'repair failed', emit, model);
        }
        await ollama.unload(model);
        report = repair;
        validation = validateUltrathinkReport(report.text, config.confidenceThreshold);
      }

      if (!validation.ok) {
        const error = `ultrathink validation failed: ${validation.issues.join('; ')}`;
        emit({ phase: 'error', message: error });
        lock.release?.();
        return failSession(requestId, error);
      }

      emit({
        phase: 'complete',
        model,
        report: report.text,
        confidence: validation.confidence,
        analyzedFiles: context.analyzedFiles,
        repositorySummary: context.repositorySummary,
      });
      completeSession(requestId);
      lock.release?.();
      return { ok: true };
    } catch (err: any) {
      await ollama.unload(model);
      const session = sessions.get(requestId);
      const error = session?.aborted ? 'aborted' : err.message || String(err);
      emit({ phase: session?.aborted ? 'cancelled' : 'error', message: error });
      completeSession(requestId);
      lock.release?.();
      return { ok: false, error };
    }
  },

  cancel(requestId: string): boolean {
    const session = sessions.get(requestId);
    if (!session || activeSessionRequestId !== requestId) return false;
    session.aborted = true;
    ollama.abort(`${requestId}::analysis`);
    ollama.abort(`${requestId}::repair`);
    ollama.unload(session.model).catch(() => {});
    return true;
  },
};

async function runUltrathinkStage(
  model: string,
  prompt: string,
  baseRequestId: string,
  win: BrowserWindow,
  stage = 'analysis'
): Promise<{ ok: boolean; text: string; error?: string }> {
  const requestId = `${baseRequestId}::${stage}`;
  let collected = '';
  let finalError: string | undefined;

  const unsubscribe = ollamaBus.subscribe(requestId, (ev) => {
    if (ev.chunk) {
      collected += ev.chunk;
      win.webContents.send('ultrathink:progress', {
        requestId: baseRequestId,
        phase: 'chunk',
        chunk: ev.chunk,
      });
    }
    if (ev.error) finalError = ev.error;
  });

  try {
    const result = await ollama.chat(
      {
        model,
        system: ULTRATHINK_SYSTEM,
        messages: [{ role: 'user', content: prompt }],
        requestId,
        keepAlive: 0,
      },
      null
    );
    if (!result.ok) finalError = result.error;
  } finally {
    unsubscribe();
  }

  if (finalError) return { ok: false, text: collected, error: finalError };
  return { ok: true, text: collected.trim() };
}

function selectModel(
  task: string,
  choice: UltrathinkModelChoice,
  config: UltrathinkConfig
): string {
  if (config.allowModelOverride && choice === 'gemma') return config.models.gemma;
  if (config.allowModelOverride && choice === 'deepseek') return config.models.deepseek;

  const lower = task.toLowerCase();
  if (/\b(review|security|validation|edge|consistency|maintainability|api)\b/.test(lower)) {
    return config.models.gemma;
  }
  if (
    /\b(debug|architecture|performance|race|async|root cause|memory leak|infra|system|websocket|reconnect)\b/.test(
      lower
    )
  ) {
    return config.models.deepseek;
  }
  return config.defaultModel || config.models.deepseek;
}

function fail(
  requestId: string,
  error: string,
  emit: (data: any) => void,
  model: string
): { ok: false; error: string } {
  ollama.unload(model).catch(() => {});
  emit({ phase: 'error', message: error });
  return failSession(requestId, error);
}

function failSession(requestId: string, error: string): { ok: false; error: string } {
  completeSession(requestId);
  return { ok: false, error };
}

function completeSession(requestId: string) {
  sessions.delete(requestId);
  if (activeSessionRequestId === requestId) activeSessionRequestId = null;
}

function isCancelled(requestId: string): boolean {
  return !!sessions.get(requestId)?.aborted;
}

function clampInt(value: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
