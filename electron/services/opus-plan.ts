import type { BrowserWindow } from 'electron';
import { anthropic } from './anthropic.js';
import { ollama } from './ollama.js';
import { ollamaBus } from './ollama-bus.js';
import { aiMutex } from './ai-mutex.js';

/**
 * Opus Plan — hybrid orchestrator.
 * Step A: Claude API breaks the task into atomic steps.
 * Step B: Local Ollama model executes each step.
 */

const PLAN_SYSTEM_PROMPT = `You are an architect. Given a user task and project context, break the task into 3-8 atomic steps for a local model to execute.

CRITICAL: respond strictly as JSON:
{
  "summary": "one sentence describing what the plan does",
  "steps": [
    {
      "id": "1",
      "title": "Short name (<=50 chars)",
      "description": "Detailed instruction for the local model. Specify files, function names, types. Local model is less capable — be explicit.",
      "files": ["relative/paths/to/files"],
      "action": "create" | "edit" | "explain"
    }
  ]
}

Do not add prose before or after the JSON.`;

const EXECUTE_SYSTEM_PROMPT = `You are a step executor. Given one atomic plan step and project context, produce concrete code or changes.

If action=create: emit the full new file content in a fenced code block with the path on the first comment line.
If action=edit: emit a diff or the new file content for the existing file.
If action=explain: just explain, no code.

Be precise. Do not add extras.`;

interface PlanStep {
  id: string;
  title: string;
  description: string;
  files: string[];
  action: 'create' | 'edit' | 'explain';
}

interface Plan {
  summary: string;
  steps: PlanStep[];
}

export const opusPlan = {
  async run(
    params: {
      brief: string;
      workspaceRoot: string;
      localModel: string;
      requestId: string;
    },
    win: BrowserWindow
  ): Promise<{ ok: boolean; error?: string }> {
    const { brief, workspaceRoot, localModel, requestId } = params;

    const emit = (data: any) => {
      win.webContents.send('opus-plan:progress', { requestId, ...data });
    };

    const lock = aiMutex.acquire('opus-plan', requestId, () => {
      for (const step of stepIds) ollama.abort(`${requestId}-step-${step}`);
    });
    const stepIds: string[] = [];
    if (!lock.ok) {
      emit({ phase: 'error', message: lock.error || 'AI lock busy' });
      return { ok: false, error: lock.error };
    }

    try {
      emit({ phase: 'planning', message: 'Claude Opus drafting steps...' });

      const hasKey = await anthropic.hasKey();
      let plan: Plan;

      if (hasKey) {
        const planResp = await anthropic.oneshot({
          model: 'claude-opus-4-7',
          system: PLAN_SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: `Project root: ${workspaceRoot}\n\nTask:\n${brief}`,
            },
          ],
          maxTokens: 8000,
          effort: 'high',
        });

        if (!planResp.ok || !planResp.text) {
          emit({ phase: 'error', message: `Planning error: ${planResp.error}` });
          return { ok: false, error: planResp.error };
        }

        try {
          let raw = planResp.text.trim();
          raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
          plan = JSON.parse(raw);
        } catch (err: any) {
          emit({
            phase: 'error',
            message: `Failed to parse plan as JSON: ${err.message}`,
          });
          return { ok: false, error: 'JSON parse error' };
        }
      } else {
        emit({
          phase: 'planning',
          message:
            'Claude API key not set — falling back to a single-step local plan (lower quality).',
        });
        plan = {
          summary: brief,
          steps: [
            {
              id: '1',
              title: 'Execute task',
              description: brief,
              files: [],
              action: 'edit',
            },
          ],
        };
      }

      emit({ phase: 'plan-ready', plan });

      for (const step of plan.steps) {
        emit({
          phase: 'step-start',
          stepId: step.id,
          title: step.title,
          message: `▶ ${step.title}`,
        });

        const stepRequestId = `${requestId}-step-${step.id}`;
        stepIds.push(step.id);
        let stepOutput = '';

        const unsubscribe = ollamaBus.subscribe(stepRequestId, (ev) => {
          if (ev.chunk) {
            stepOutput += ev.chunk;
            emit({ phase: 'step-chunk', stepId: step.id, chunk: ev.chunk });
          }
        });

        try {
          await ollama.chat(
            {
              model: localModel,
              system: EXECUTE_SYSTEM_PROMPT,
              messages: [
                {
                  role: 'user',
                  content: `STEP: ${step.title}\n\n${step.description}\n\nFiles: ${
                    step.files.join(', ') || '(none specified)'
                  }`,
                },
              ],
              requestId: stepRequestId,
            },
            null
          );
        } finally {
          unsubscribe();
        }

        emit({ phase: 'step-done', stepId: step.id, output: stepOutput });
      }

      emit({ phase: 'complete', message: 'All steps complete' });
      return { ok: true };
    } finally {
      lock.release?.();
    }
  },
};
