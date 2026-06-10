import { useStore } from '../hooks/useStore';
import { genId } from './utils';

/**
 * Handle the `/plan` slash command — Opus Plan hybrid mode.
 * Claude API designs the plan, local model executes each step.
 */
export async function runOpusPlan(brief: string) {
  const state = useStore.getState();
  const { selectedModel, workspaceRoot, availableModels, addMessage } = state;

  if (!brief.trim()) {
    addMessage({
      id: genId(),
      role: 'assistant',
      content: '⚠️ Использование: `/plan <описание задачи>`',
      timestamp: Date.now(),
    });
    return;
  }

  if (!workspaceRoot) {
    addMessage({
      id: genId(),
      role: 'assistant',
      content: '⚠️ Сначала откройте папку проекта.',
      timestamp: Date.now(),
    });
    return;
  }

  // Need a local model for execution
  const localModel =
    selectedModel?.provider === 'ollama'
      ? selectedModel.id
      : availableModels.find((m) => m.provider === 'ollama')?.id;

  if (!localModel) {
    addMessage({
      id: genId(),
      role: 'assistant',
      content:
        '⚠️ Для opus-plan нужна локальная модель из Ollama. Установите хотя бы одну (например, qwen2.5-coder:7b).',
      timestamp: Date.now(),
    });
    return;
  }

  // Echo command
  addMessage({
    id: genId(),
    role: 'user',
    content: `/plan ${brief}`,
    timestamp: Date.now(),
  });

  const msgId = genId();
  addMessage({
    id: msgId,
    role: 'assistant',
    content: '🧠 **Opus Plan** — Claude планирует, локалка исполняет.\n\n',
    timestamp: Date.now(),
    streaming: true,
  });

  const requestId = genId();

  const off = window.api.opusPlan.onProgress((data: any) => {
    if (data.requestId !== requestId) return;
    switch (data.phase) {
      case 'planning':
        state.appendToMessage(msgId, `\n${data.message}`);
        break;
      case 'plan-ready':
        state.appendToMessage(msgId, `\n\n**План:** ${data.plan.summary}\n\n`);
        data.plan.steps.forEach((s: any, i: number) => {
          state.appendToMessage(msgId, `${i + 1}. **${s.title}** — ${s.description.slice(0, 80)}...\n`);
        });
        state.appendToMessage(msgId, '\n---\n\n');
        break;
      case 'step-start':
        state.appendToMessage(msgId, `\n\n### ${data.message}\n\n`);
        break;
      case 'step-chunk':
        state.appendToMessage(msgId, data.chunk || '');
        break;
      case 'step-done':
        state.appendToMessage(msgId, '\n\n✓\n');
        break;
      case 'complete':
        state.appendToMessage(msgId, `\n\n${data.message}`);
        state.finishMessage(msgId);
        off();
        break;
      case 'error':
        state.appendToMessage(msgId, `\n\n❌ ${data.message}`);
        state.finishMessage(msgId, data.message);
        off();
        break;
    }
  });

  const result = await window.api.opusPlan.run({
    brief,
    workspaceRoot,
    localModel,
    requestId,
  });

  if (!result.ok) {
    state.appendToMessage(msgId, `\n\n❌ ${result.error}`);
    state.finishMessage(msgId, result.error);
    off();
  }
}
