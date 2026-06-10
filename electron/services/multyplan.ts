import type { BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ollama } from './ollama.js';
import { ollamaBus } from './ollama-bus.js';
import { workspace } from './workspace.js';
import { agent } from './agent.js';
import { aiMutex } from './ai-mutex.js';
import { appSettings } from './settings.js';
import { terminal } from './terminal.js';
import { brain } from './brain.js';

/**
 * /multyplan — sequential multi-model planning + coding workflow.
 *
 * Stages (STRICTLY sequential; only one local model resident at a time):
 *   1. Planner (default: deepseek-r1)   → initial implementation plan
 *   2. Critic  (default: gemma-4)       → review + up to N challenge questions
 *      ↔ Planner answers each question (1 by 1)
 *   3. Coordinator merges plan + critique → final structured plan (14 sections)
 *   4. Wait for explicit user approval
 *   5. Executor (default: qwen3-coder)  → writes code via the file-tool agent
 */

export interface MultyplanConfig {
  maxDebateRounds: number;
  requireUserApproval: boolean;
  sequentialExecutionOnly: boolean;
  models: {
    planner: string;
    critic: string;
    executor: string;
  };
}

export const DEFAULT_MULTYPLAN_CONFIG: MultyplanConfig = {
  maxDebateRounds: 3,
  requireUserApproval: true,
  sequentialExecutionOnly: true,
  models: {
    planner: 'deepseek-r1:32b',
    critic: 'gemma4:26b',
    executor: 'qwen3-coder:30b',
  },
};

interface PendingSession {
  requestId: string;
  win: BrowserWindow;
  finalPlan: string;
  config: MultyplanConfig;
  workspaceRoot: string;
  brief: string;
  approval: Promise<{ approved: boolean; edits?: string }>;
  resolveApproval: (v: { approved: boolean; edits?: string }) => void;
  approvalSettled: boolean;
  aborted: boolean;
}

const pendingSessions = new Map<string, PendingSession>();
let activeSessionRequestId: string | null = null;

const FINAL_PLAN_SECTIONS = [
  'Task summary',
  'Files to inspect',
  'Files to modify',
  'Exact functions/classes/modules involved',
  'Step-by-step implementation instructions',
  'Data flow changes',
  'API / interface changes',
  'Edge cases',
  'Error handling requirements',
  'Backward compatibility requirements',
  'Tests to add or update',
  'Commands to run after implementation',
  'Things the coder must NOT change',
  'Acceptance criteria',
];

const PLANNER_SYSTEM = `You are a senior implementation planner. Your only job is to produce an implementation PLAN for a coding task.

RULES:
- Do not write code. Plan only.
- Analyze the task and repository context.
- List files to read and files to modify.
- Identify functions/classes/modules touched.
- Write implementation steps in correct order.
- Note risks, edge cases, backward-compatibility requirements.
- Be specific: filenames, function names, ordering.

Structure (markdown):
## Summary
## Files to inspect
## Files to modify
## Functions / modules
## Implementation steps
## Risks and edge cases
## Backward compatibility
## What NOT to change`;

const CRITIC_SYSTEM = `You are a plan reviewer. Given:
1) user task,
2) repository context,
3) planner's plan,

Your job:
- Find missing files, wrong assumptions, missed edge cases.
- Check architecture risks.
- Produce UP TO 3 clarifying questions OR an "approve" verdict.

Reply STRICTLY as JSON (no markdown wrapper):
{
  "verdict": "questions" | "approve",
  "summary": "1-2 sentences on the key defects or reason for approval",
  "questions": ["q1", "q2", "q3"]
}

If verdict="approve" — questions is an empty array. Never add prose outside the JSON.`;

const CRITIC_FINAL_SYSTEM = `You are a plan reviewer. Given the original plan, the planner's answers, and the repository context, produce a FINAL critique in free-form markdown.
Be specific. List:
- remaining weaknesses
- what must be accounted for
- mandatory tests
- backward-compatibility guarantees needed.`;

const COORDINATOR_FINAL_PLAN_TEMPLATE = (
  brief: string,
  plannerPlan: string,
  criticFinal: string,
  groundedCode: string
) => `Using the inputs below, assemble a SINGLE final plan for the code executor (Qwen3-Coder).

Original task:
${brief}

Planner's plan:
${plannerPlan}

Final critique:
${criticFinal}
${groundedCode ? `\nGROUND TRUTH — actual current code (trust this over the plan if they conflict):\n${groundedCode}\n` : ''}
The final plan MUST be consistent with the ground-truth code above: only reference functions, files and symbols that actually exist (or are explicitly created as new files).

The final plan MUST include exactly these 14 markdown sections:
1. Task summary
2. Files to inspect
3. Files to modify
4. Exact functions/classes/modules involved
5. Step-by-step implementation instructions
6. Data flow changes
7. API / interface changes (if any)
8. Edge cases
9. Error handling requirements
10. Backward compatibility requirements
11. Tests to add or update
12. Commands to run after implementation
13. Things the coder must NOT change
14. Acceptance criteria

Be concrete: file names, function signatures, exact steps. No "etc." or "TBD". Do not write code in the plan.`;

const EXECUTOR_SYSTEM = `You are Qwen3-Coder, a code executor. You have an APPROVED plan. Make the changes via the available tools (search, read_file, edit_file, create_file, list_dir, delete_file, run_command).

HOW TO WORK:
- Follow the plan, but VERIFY against reality. Before editing, read the file (read_file) and confirm the functions/symbols the plan mentions actually exist. Use search to locate code when the plan is vague about where something is.
- If the plan references code that does NOT exist or is wrong (e.g. a function/file that isn't there), ADAPT: do the right thing to satisfy the task's intent, and note the deviation in your final summary. A wrong plan is not a reason to write broken code.
- Stay within the spirit of "Files to modify"; if you must touch another file to make it work, do it and explain why.
- Do not invent APIs. Confirm signatures by reading the real code first.
- For existing files use edit_file with surgical replacements. No "// rest of code".
- Respect "Things the coder must NOT change".
- If terminal is available, you may run_command to typecheck/test your changes (e.g. tsc, the project's test script) and fix what breaks.
- At the end, give a short summary of changes, the list of touched files, and any deviations from the plan.`;

async function buildRepoContext(workspaceRoot: string): Promise<string> {
  try {
    const tree = await workspace.listFiles(workspaceRoot);
    const lines: string[] = [];
    const walk = (node: any, depth: number) => {
      if (lines.length >= 200) return;
      if (depth > 0) {
        const indent = '  '.repeat(depth - 1);
        lines.push(`${indent}${node.isDir ? '▸' : '-'} ${node.name}`);
      } else {
        lines.push(node.name);
      }
      if (node.isDir && node.children && depth < 4) {
        for (const c of node.children) {
          walk(c, depth + 1);
          if (lines.length >= 200) break;
        }
      }
    };
    walk(tree, 0);
    const symbolMap = await buildSymbolMap(workspaceRoot);
    return [
      `Root: ${workspaceRoot}`,
      '',
      '[Tree]',
      lines.join('\n'),
      symbolMap ? `\n${symbolMap}` : '',
    ].join('\n');
  } catch {
    return `Root: ${workspaceRoot} (tree could not be read)`;
  }
}

const SRC_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.rb', '.php', '.cs', '.vue', '.svelte',
]);
// Top-level declarations worth surfacing to a blind planner.
const SIG_RE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|def|func|fn)\s+[A-Za-z0-9_$]+/;

/**
 * Build a compact "symbol map": for each source file, the top-level
 * function/class/interface/const declarations. Gives the planner a real view
 * of the code's surface without reading entire files. Heuristic + bounded.
 */
async function buildSymbolMap(root: string): Promise<string> {
  const ignored = new Set(appSettings.get().workspace.ignoredFolders);
  const out: string[] = [];
  let files = 0;
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && files < 60 && out.length < 600) {
    const { dir, depth } = stack.pop()!;
    if (depth > 4) continue;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (ignored.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!SRC_EXT.has(path.extname(e.name).toLowerCase())) continue;
      if (files >= 60) break;
      let content: string;
      try {
        content = await fs.readFile(full, 'utf-8');
      } catch {
        continue;
      }
      if (content.length > 200_000) continue;
      const sigs: string[] = [];
      for (const line of content.split('\n')) {
        if (SIG_RE.test(line)) {
          sigs.push(line.trim().replace(/\s*\{?\s*$/, '').slice(0, 120));
          if (sigs.length >= 12) break;
        }
      }
      if (sigs.length > 0) {
        files++;
        const rel = path.relative(root, full).replace(/\\/g, '/');
        out.push(`\n${rel}:`);
        for (const s of sigs) out.push(`  ${s}`);
      }
    }
  }
  return out.length > 0 ? `[Symbol map — key declarations per file]${out.join('\n')}` : '';
}

/** Extract candidate source-file paths mentioned anywhere in a plan/text. */
function extractPlanPaths(text: string): string[] {
  const re =
    /[A-Za-z0-9_\-./\\]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|scss|html|md|py|go|rs|java|rb|php|cs|vue|svelte)\b/g;
  const set = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    set.add(m[0].replace(/\\/g, '/'));
    if (set.size >= 40) break;
  }
  return [...set];
}

/**
 * Read the ACTUAL current contents of files referenced by the plan, so the
 * merge/critique stage is grounded in real code instead of guessed structure.
 * Bounded in count and per-file size.
 */
async function readReferencedFiles(workspaceRoot: string, paths: string[]): Promise<string> {
  const parts: string[] = [];
  let used = 0;
  for (const p of paths) {
    if (used >= 12) break;
    const c = workspace.resolveAgentPath(p, workspaceRoot);
    if (!c.ok || !c.absolute) continue;
    const r = await workspace.readFile(c.absolute);
    if (!r.ok || !r.content) continue;
    used++;
    const body =
      r.content.length > 6000 ? r.content.slice(0, 6000) + '\n[... truncated ...]' : r.content;
    parts.push(`\n----- ${p} -----\n${body}`);
  }
  return parts.length > 0
    ? `[Actual current code of files referenced by the plan]\n${parts.join('\n')}`
    : '';
}

async function runOllamaStage(
  model: string,
  systemPrompt: string,
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[],
  stageId: string,
  baseRequestId: string,
  win: BrowserWindow
): Promise<{ ok: boolean; text: string; error?: string }> {
  const subRequestId = `${baseRequestId}::${stageId}`;
  let collected = '';
  let finalError: string | undefined;

  const unsubscribe = ollamaBus.subscribe(subRequestId, (ev) => {
    if (ev.chunk) {
      collected += ev.chunk;
      win.webContents.send('multyplan:progress', {
        requestId: baseRequestId,
        stage: stageId,
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
        messages,
        system: systemPrompt,
        requestId: subRequestId,
        keepAlive: 0,
      },
      null
    );
    if (!result.ok) finalError = result.error;
  } finally {
    unsubscribe();
  }

  if (finalError) return { ok: false, text: collected, error: finalError };
  return { ok: true, text: collected };
}

function parseCriticJson(text: string): {
  verdict: 'questions' | 'approve';
  summary: string;
  questions: string[];
} {
  let raw = text.trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    raw = raw.slice(first, last + 1);
  }
  try {
    const obj = JSON.parse(raw);
    return {
      verdict: obj.verdict === 'approve' ? 'approve' : 'questions',
      summary: String(obj.summary || ''),
      questions: Array.isArray(obj.questions)
        ? obj.questions.filter((q: any) => typeof q === 'string' && q.trim()).slice(0, 3)
        : [],
    };
  } catch {
    return { verdict: 'approve', summary: raw.slice(0, 400), questions: [] };
  }
}

export function normalizeMultyplanConfig(config?: Partial<MultyplanConfig>): MultyplanConfig {
  const requestedRounds = Number(config?.maxDebateRounds ?? DEFAULT_MULTYPLAN_CONFIG.maxDebateRounds);
  const maxDebateRounds = Number.isFinite(requestedRounds)
    ? Math.max(0, Math.min(3, Math.floor(requestedRounds)))
    : DEFAULT_MULTYPLAN_CONFIG.maxDebateRounds;

  return {
    ...DEFAULT_MULTYPLAN_CONFIG,
    ...config,
    maxDebateRounds,
    requireUserApproval: true,
    sequentialExecutionOnly: true,
    models: {
      ...DEFAULT_MULTYPLAN_CONFIG.models,
      ...(config?.models || {}),
    },
  };
}

async function resolveConfiguredModels(
  models: MultyplanConfig['models']
): Promise<{ ok: boolean; models?: MultyplanConfig['models']; error?: string }> {
  const installed = await ollama.list();
  const names = installed.map((m) => m.name).filter(Boolean);
  if (names.length === 0) {
    return { ok: false, error: 'No Ollama models are installed or Ollama is not reachable.' };
  }

  const planner = resolveModelName(models.planner, names, ['deepseek-r1', 'deepseek']);
  const critic = resolveModelName(models.critic, names, ['gemma4', 'gemma-4', 'gemma']);
  const executor = resolveModelName(models.executor, names, ['qwen3-coder', 'qwen-coder', 'qwen']);
  const missing = [
    planner ? null : `planner=${models.planner}`,
    critic ? null : `critic=${models.critic}`,
    executor ? null : `executor=${models.executor}`,
  ].filter(Boolean);

  if (!planner || !critic || !executor) {
    return {
      ok: false,
      error: `Configured model not found (${missing.join(', ')}). Installed models: ${names.join(', ')}`,
    };
  }

  return { ok: true, models: { planner, critic, executor } };
}

function resolveModelName(requested: string, installed: string[], fallbacks: string[]): string | null {
  const candidates = [requested, ...fallbacks].map((s) => String(s || '').trim()).filter(Boolean);
  for (const candidate of candidates) {
    const exact = installed.find((name) => name === candidate);
    if (exact) return exact;
    const tagged = installed.find((name) => name.startsWith(`${candidate}:`));
    if (tagged) return tagged;
    const wanted = normalizeModelAlias(candidate);
    const loose = installed.find((name) => {
      const base = name.split(':')[0];
      const normalizedName = normalizeModelAlias(name);
      const normalizedBase = normalizeModelAlias(base);
      return normalizedBase === wanted || normalizedName.startsWith(wanted);
    });
    if (loose) return loose;
  }
  return null;
}

function normalizeModelAlias(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function validateFinalPlan(plan: string): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const normalized = plan.toLowerCase();

  for (const section of FINAL_PLAN_SECTIONS) {
    if (!normalized.includes(section.toLowerCase())) {
      issues.push(`missing section: ${section}`);
    }
  }

  if (!/[A-Za-z0-9_\-/\\]+\.(ts|tsx|js|jsx|json|css|scss|html|md|cjs|mjs)\b/i.test(plan)) {
    issues.push('missing concrete file paths');
  }
  if (!/\b(test|tests|npm|pnpm|yarn|vitest|jest|tsc|build)\b/i.test(plan)) {
    issues.push('missing concrete verification commands or tests');
  }
  if (/\b(and so on|etc\.|todo|tbd)\b/i.test(plan)) {
    issues.push('contains vague placeholders');
  }

  return { ok: issues.length === 0, issues };
}

function completeSession(requestId: string) {
  pendingSessions.delete(requestId);
  if (activeSessionRequestId === requestId) activeSessionRequestId = null;
}

export const multyplan = {
  defaultConfig: DEFAULT_MULTYPLAN_CONFIG,

  async start(
    params: {
      brief: string;
      workspaceRoot: string;
      requestId: string;
      config: MultyplanConfig;
    },
    win: BrowserWindow
  ): Promise<{ ok: boolean; error?: string }> {
    const { brief, workspaceRoot, requestId } = params;
    const config = normalizeMultyplanConfig(params.config);
    const emit = (data: any) =>
      win.webContents.send('multyplan:progress', { requestId, ...data });

    if (activeSessionRequestId && activeSessionRequestId !== requestId) {
      const error = 'multyplan already running';
      emit({ phase: 'error', message: 'Multyplan already has an active session. Finish or cancel it first.' });
      return { ok: false, error };
    }

    const lock = aiMutex.acquire('multyplan', requestId, () => {
      multyplan.cancel(requestId);
    });
    if (!lock.ok) {
      emit({ phase: 'error', message: lock.error || 'AI lock busy' });
      return { ok: false, error: lock.error };
    }

    if (!brief.trim()) {
      emit({ phase: 'error', message: 'Empty brief for /multyplan' });
      lock.release?.();
      return { ok: false, error: 'empty brief' };
    }
    if (!workspaceRoot) {
      emit({ phase: 'error', message: 'No project folder open' });
      lock.release?.();
      return { ok: false, error: 'no workspace' };
    }

    const resolvedModels = await resolveConfiguredModels(config.models);
    if (!resolvedModels.ok || !resolvedModels.models) {
      emit({ phase: 'error', message: resolvedModels.error || 'Configured multyplan models are unavailable.' });
      lock.release?.();
      return { ok: false, error: resolvedModels.error || 'models unavailable' };
    }
    config.models = resolvedModels.models;

    activeSessionRequestId = requestId;
    const repoContext = await buildRepoContext(workspaceRoot);

    let resolveApproval!: (v: { approved: boolean; edits?: string }) => void;
    const approval = new Promise<{ approved: boolean; edits?: string }>((resolve) => {
      resolveApproval = resolve;
    });
    const session: PendingSession = {
      requestId,
      win,
      finalPlan: '',
      config,
      workspaceRoot,
      brief,
      approval,
      resolveApproval: (v) => {
        if (session.approvalSettled) return;
        session.approvalSettled = true;
        resolveApproval(v);
      },
      approvalSettled: false,
      aborted: false,
    };
    pendingSessions.set(requestId, session);

    const failHere = (msg: string) => {
      emit({ phase: 'error', message: msg });
      completeSession(requestId);
      lock.release?.();
      return { ok: false as const, error: msg };
    };

    try {
      // Stage 1: Planner
      emit({
        stage: 'planner',
        phase: 'start',
        message: `Stage 1/4 — ${config.models.planner} drafting plan`,
      });
      const plannerResult = await runOllamaStage(
        config.models.planner,
        PLANNER_SYSTEM,
        [{ role: 'user', content: `Task:\n${brief}\n\nRepo context:\n${repoContext}` }],
        'planner',
        requestId,
        win
      );
      if (!plannerResult.ok) {
        await ollama.unload(config.models.planner);
        return failHere(`Planner failed: ${plannerResult.error}`);
      }
      emit({ stage: 'planner', phase: 'end' });
      await ollama.unload(config.models.planner);

      const plannerPlan = plannerResult.text.trim();

      // Ground the plan: read the ACTUAL code of files the planner referenced,
      // so the critic and merge stages work against reality, not guesses.
      const groundedCode = await readReferencedFiles(
        workspaceRoot,
        extractPlanPaths(plannerPlan)
      );

      // Stage 2: Critic initial review
      emit({
        stage: 'critic',
        phase: 'start',
        message: `Stage 2/4 — ${config.models.critic} reviewing plan`,
      });
      const criticReviewResult = await runOllamaStage(
        config.models.critic,
        CRITIC_SYSTEM,
        [
          {
            role: 'user',
            content: `User task:\n${brief}\n\nRepo context:\n${repoContext}\n\nPlanner's plan:\n${plannerPlan}`,
          },
        ],
        'critic-review',
        requestId,
        win
      );
      if (!criticReviewResult.ok) {
        await ollama.unload(config.models.critic);
        return failHere(`Critic failed: ${criticReviewResult.error}`);
      }
      await ollama.unload(config.models.critic);

      const parsed = parseCriticJson(criticReviewResult.text);
      emit({
        stage: 'critic',
        phase: 'parsed',
        verdict: parsed.verdict,
        summary: parsed.summary,
        questions: parsed.questions,
      });

      // Stage 2b: Debate — answer ALL reviewer questions in ONE planner turn.
      // (Previously one turn per question, which reloaded the 32B planner from
      // disk each time — very slow. Batching keeps the model resident once.)
      const askQuestions = config.maxDebateRounds > 0 ? parsed.questions : [];
      const qaTranscript: { question: string; answer: string }[] = [];

      if (askQuestions.length > 0) {
        const numbered = askQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n');
        emit({
          stage: 'debate',
          phase: 'round-start',
          round: 1,
          totalRounds: 1,
          question: numbered,
        });

        const ansResult = await runOllamaStage(
          config.models.planner,
          PLANNER_SYSTEM +
            '\n\nADDITIONAL: the plan reviewer asked clarifying questions. Answer each one concisely and concretely (numbered to match). Do not rewrite the whole plan.',
          [
            { role: 'user', content: `Task:\n${brief}\n\nContext:\n${repoContext}` },
            { role: 'assistant', content: plannerPlan },
            { role: 'user', content: `Reviewer questions:\n${numbered}` },
          ],
          'planner-answers',
          requestId,
          win
        );
        if (!ansResult.ok) {
          await ollama.unload(config.models.planner);
          return failHere(`Planner answers failed: ${ansResult.error}`);
        }
        await ollama.unload(config.models.planner);
        qaTranscript.push({ question: numbered, answer: ansResult.text.trim() });

        emit({ stage: 'debate', phase: 'round-end', round: 1, answer: ansResult.text.trim() });
      }

      // Stage 2c: Critic final critique
      emit({
        stage: 'critic-final',
        phase: 'start',
        message: `${config.models.critic} producing final critique`,
      });
      const debateBlock = qaTranscript
        .map((qa, i) => `Q${i + 1}: ${qa.question}\nA${i + 1}: ${qa.answer}`)
        .join('\n\n');
      const criticFinalResult = await runOllamaStage(
        config.models.critic,
        CRITIC_FINAL_SYSTEM,
        [
          {
            role: 'user',
            content: `Task:\n${brief}\n\nContext:\n${repoContext}\n\nPlan:\n${plannerPlan}\n\nDiscussion:\n${
              debateBlock || '(no questions)'
            }${groundedCode ? `\n\n${groundedCode}` : ''}`,
          },
        ],
        'critic-final',
        requestId,
        win
      );
      if (!criticFinalResult.ok) {
        await ollama.unload(config.models.critic);
        return failHere(`Final critique failed: ${criticFinalResult.error}`);
      }
      await ollama.unload(config.models.critic);
      emit({ stage: 'critic-final', phase: 'end' });

      // Stage 3: merge via planner
      emit({
        stage: 'merge',
        phase: 'start',
        message: `Stage 3/4 — assembling final plan for ${config.models.executor}`,
      });
      const mergeResult = await runOllamaStage(
        config.models.planner,
        PLANNER_SYSTEM +
          '\n\nADDITIONAL: your final task is to assemble ONE strictly-structured 14-section plan for the code executor.',
        [
          {
            role: 'user',
            content: COORDINATOR_FINAL_PLAN_TEMPLATE(
              brief,
              plannerPlan,
              criticFinalResult.text.trim(),
              groundedCode
            ),
          },
        ],
        'merge',
        requestId,
        win
      );
      if (!mergeResult.ok) {
        await ollama.unload(config.models.planner);
        return failHere(`Plan merge failed: ${mergeResult.error}`);
      }
      await ollama.unload(config.models.planner);
      const finalPlan = mergeResult.text.trim();
      const validation = validateFinalPlan(finalPlan);
      if (!validation.ok) {
        return failHere(`final plan is incomplete: ${validation.issues.join('; ')}`);
      }
      session.finalPlan = finalPlan;
      emit({ stage: 'merge', phase: 'end' });
      emit({ phase: 'final-plan', plan: finalPlan });

      // Stage 4: Wait for approval
      emit({ phase: 'awaiting-approval' });
      const decision = await session.approval;
      if (session.aborted) {
        emit({ phase: 'rejected', message: 'Session cancelled by user' });
        completeSession(requestId);
        lock.release?.();
        return { ok: false, error: 'aborted' };
      }
      if (!decision.approved) {
        emit({ phase: 'rejected', message: 'User rejected the plan' });
        completeSession(requestId);
        lock.release?.();
        return { ok: true };
      }
      if (decision.edits && decision.edits.trim()) {
        session.finalPlan = decision.edits.trim();
        const editedValidation = validateFinalPlan(session.finalPlan);
        if (!editedValidation.ok) {
          return failHere(`approved plan is incomplete: ${editedValidation.issues.join('; ')}`);
        }
        emit({ phase: 'plan-edited', plan: session.finalPlan });
      }
      emit({ phase: 'approved' });

      // Stage 5: Executor
      emit({
        stage: 'executor',
        phase: 'start',
        message: `Stage 4/4 — ${config.models.executor} writing code`,
      });

      const off = forwardAgentEvents(win, requestId);
      let execResult: { ok: boolean; error?: string };
      try {
        execResult = await agent.chat(
          {
            model: config.models.executor,
            messages: [
              {
                role: 'user',
                content: `Approved implementation plan:\n\n${session.finalPlan}\n\nOriginal request:\n${brief}\n\nFollow the plan. Read/verify the real code before editing; if the plan conflicts with the actual code, adapt and note it. End with a short summary.`,
              },
            ],
            system: EXECUTOR_SYSTEM,
            workspaceRoot,
            requestId: `${requestId}::executor`,
            logWorklog: false, // multyplan logs one consolidated entry at the end
          },
          win
        );
        if (!execResult.ok) {
          return failHere(`Executor failed: ${execResult.error}`);
        }

        // Stage 5b: verify the code actually compiles, fix loop if not.
        // Runs with the executor model still resident (no reload between tries).
        await verifyAndFix({
          workspaceRoot,
          win,
          requestId,
          config,
          brief,
          emit,
        });
      } finally {
        off();
        await ollama.unload(config.models.executor);
      }

      emit({ stage: 'executor', phase: 'end' });

      // One consolidated "what was done" entry for the whole multyplan task.
      try {
        brain.logWork({
          title: brief.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Multyplan task',
          summary: 'multyplan: plan → critique → execute → verify',
          details: session.finalPlan.slice(0, 4000),
          projectRoot: workspaceRoot,
          sourceRef: requestId,
        });
      } catch {
        /* never break completion on worklog */
      }

      emit({ phase: 'complete', message: 'Multyplan completed' });
      completeSession(requestId);
      lock.release?.();
      return { ok: true };
    } catch (err: any) {
      emit({ phase: 'error', message: err.message || String(err) });
      completeSession(requestId);
      lock.release?.();
      return { ok: false, error: err.message };
    }
  },

  approve(requestId: string, decision: { approved: boolean; edits?: string }): boolean {
    const s = pendingSessions.get(requestId);
    if (!s) return false;
    s.resolveApproval(decision);
    return true;
  },

  cancel(requestId: string): boolean {
    const s = pendingSessions.get(requestId);
    if (s) {
      s.aborted = true;
      s.resolveApproval({ approved: false });
    }
    agent.abort(`${requestId}::executor`);
    for (const stage of ['planner', 'critic-review', 'critic-final', 'merge', 'planner-answers']) {
      ollama.abort(`${requestId}::${stage}`);
    }
    return !!s;
  },
};

/**
 * Forward agent events to the multyplan progress feed for the executor stage.
 * Scoped to the duration of the executor call by the caller (off() in finally).
 */
function forwardAgentEvents(win: BrowserWindow, baseRequestId: string): () => void {
  const target = `${baseRequestId}::executor`;
  const origSend = win.webContents.send.bind(win.webContents);
  const interceptor = (channel: string, data: any) => {
    if (channel === 'agent:chunk' && data && data.requestId === target) {
      origSend('multyplan:progress', {
        requestId: baseRequestId,
        stage: 'executor',
        phase: 'agent',
        agentKind: data.kind,
        chunk: data.chunk,
        tool: data.tool,
        args: data.args,
        ok: data.ok,
        summary: data.summary,
        error: data.error,
        done: data.done,
      });
      origSend(channel, data);
      return;
    }
    origSend(channel, data);
  };
  (win.webContents as any).send = interceptor;
  return () => {
    (win.webContents as any).send = origSend;
  };
}

/**
 * Pick a safe, non-watch verification command for the workspace.
 * Prefers an explicit typecheck script, else `tsc --noEmit` for TS projects,
 * else a build script. Returns [] when nothing suitable is found.
 */
async function detectVerifyCommands(root: string): Promise<string[]> {
  const cmds: string[] = [];
  let pkg: any = null;
  try {
    pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf-8'));
  } catch {
    /* no package.json */
  }
  const scripts = (pkg && pkg.scripts) || {};
  const hasTsconfig = await fs
    .access(path.join(root, 'tsconfig.json'))
    .then(() => true)
    .catch(() => false);

  if (typeof scripts.typecheck === 'string') cmds.push('npm run typecheck');
  else if (hasTsconfig) cmds.push('npx tsc --noEmit');
  else if (typeof scripts.build === 'string') cmds.push('npm run build');
  return cmds;
}

/**
 * Run verification (typecheck/build) after the executor. On failure, feed the
 * errors back to the executor model and let it fix, up to MAX_FIX attempts.
 * No-op (with a notice) when the terminal is disabled or nothing to run.
 *
 * NOTE: relies on the caller's forwardAgentEvents interceptor still being
 * active, so the fix-agent's tool calls show up in the multyplan feed.
 */
async function verifyAndFix(params: {
  workspaceRoot: string;
  win: BrowserWindow;
  requestId: string;
  config: MultyplanConfig;
  brief: string;
  emit: (data: any) => void;
}): Promise<void> {
  const { workspaceRoot, win, requestId, config, brief, emit } = params;

  if (!appSettings.get().agent.allowTerminal) {
    emit({
      stage: 'verify',
      phase: 'skipped',
      message:
        'Verification skipped — enable Settings → Agent → "Allow terminal commands" to auto-run typecheck/tests.',
    });
    return;
  }

  const cmds = await detectVerifyCommands(workspaceRoot);
  if (cmds.length === 0) {
    emit({ stage: 'verify', phase: 'skipped', message: 'No typecheck/build command detected.' });
    return;
  }

  const MAX_FIX = 2;
  for (let attempt = 0; attempt <= MAX_FIX; attempt++) {
    let failure: { cmd: string; out: string } | null = null;

    for (const cmd of cmds) {
      emit({ stage: 'verify', phase: 'run', message: `Verifying: ${cmd}`, command: cmd, attempt });
      const subId = `${requestId}::verify-${attempt}-${Date.now().toString(36)}`;
      const r = await terminal.run({ command: cmd, requestId: subId, timeoutMs: 5 * 60 * 1000 }, win);
      const failed = !r.ok || (r.code ?? 1) !== 0;
      if (failed) {
        failure = {
          cmd,
          out: [r.error, r.stdout, r.stderr].filter(Boolean).join('\n').trim(),
        };
        break;
      }
    }

    if (!failure) {
      emit({ stage: 'verify', phase: 'pass', message: '✓ Verification passed' });
      return;
    }

    if (attempt === MAX_FIX) {
      emit({
        stage: 'verify',
        phase: 'fail',
        message: `Verification still failing after ${MAX_FIX} fix attempt(s): ${failure.cmd}`,
        output: failure.out.slice(0, 2000),
      });
      return;
    }

    emit({
      stage: 'verify',
      phase: 'fixing',
      message: `Verification failed (${failure.cmd}) — ${config.models.executor} fixing (attempt ${
        attempt + 1
      }/${MAX_FIX})`,
    });

    await agent.chat(
      {
        model: config.models.executor,
        messages: [
          {
            role: 'user',
            content: `Your changes for this task did NOT pass verification.\n\nTask:\n${brief}\n\nCommand: ${failure.cmd}\nOutput:\n${failure.out.slice(
              0,
              6000
            )}\n\nFix these errors. Use search/read_file to inspect and edit_file to fix. Change only what is needed to make "${failure.cmd}" pass. End with a short summary.`,
          },
        ],
        system: EXECUTOR_SYSTEM,
        workspaceRoot,
        requestId: `${requestId}::executor`,
        logWorklog: false,
      },
      win
    );
  }
}
