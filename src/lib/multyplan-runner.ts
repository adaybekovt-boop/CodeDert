import { useStore } from '../hooks/useStore';
import { genId } from './utils';

/**
 * /multyplan slash command runner (renderer side).
 *
 * The orchestration lives in the main process (electron/services/multyplan.ts);
 * here we only:
 *   1. echo the user command,
 *   2. open a single assistant message that streams every stage,
 *   3. set `awaitingApproval` when the main process pauses for user input,
 *   4. surface success / error / cancel.
 */
export async function runMultyplan(brief: string) {
  const state = useStore.getState();
  const { workspaceRoot, addMessage } = state;

  if (!brief.trim()) {
    addMessage({
      id: genId(),
      role: 'assistant',
      content: '⚠️ Использование: `/multyplan <описание задачи>`',
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

  // Echo user
  addMessage({
    id: genId(),
    role: 'user',
    content: `/multyplan ${brief}`,
    timestamp: Date.now(),
  });

  // Pull config (with defaults baked in by the main process)
  const config = await window.api.multyplan.getConfig();
  state.setStreaming(true);

  const msgId = genId();
  addMessage({
    id: msgId,
    role: 'assistant',
    content: `🧩 **Multyplan** — последовательный многомодельный пайплайн.\n\n_Конфигурация:_ planner=\`${config.models.planner}\`, critic=\`${config.models.critic}\`, executor=\`${config.models.executor}\`, maxDebateRounds=${config.maxDebateRounds}.\n\n`,
    timestamp: Date.now(),
    streaming: true,
  });

  const requestId = genId();
  let currentStage = '';

  const append = (chunk: string) => state.appendToMessage(msgId, chunk);

  const off = window.api.multyplan.onProgress((data: any) => {
    if (data.requestId !== requestId) return;

    // Stage banners
    if (data.phase === 'start' && data.message) {
      currentStage = data.stage || currentStage;
      append(`\n\n### ${data.message}\n\n`);
      return;
    }
    if (data.phase === 'end') {
      append('\n\n✓\n');
      return;
    }
    if (data.phase === 'chunk' && data.chunk) {
      append(data.chunk);
      return;
    }
    if (data.phase === 'parsed') {
      // Critic JSON parsed
      if (data.verdict === 'approve') {
        append(
          `\n\n_Критик одобрил без вопросов._${
            data.summary ? `\n_Резюме:_ ${data.summary}` : ''
          }\n`
        );
      } else {
        append(
          `\n\n_Критик задаёт ${data.questions?.length || 0} вопрос(ов):_\n${
            (data.questions || [])
              .map((q: string, i: number) => `${i + 1}. ${q}`)
              .join('\n')
          }\n`
        );
      }
      return;
    }
    if (data.phase === 'round-start') {
      append(
        `\n\n#### ↔ Раунд ${data.round}/${data.totalRounds}: вопрос критика\n> ${data.question}\n\n**Ответ планировщика:**\n\n`
      );
      return;
    }
    if (data.phase === 'round-end') {
      append('\n\n— конец раунда —\n');
      return;
    }
    if (data.phase === 'final-plan') {
      append(
        `\n\n---\n\n## 📋 Финальный план (для исполнителя)\n\n${data.plan}\n\n---\n`
      );
      return;
    }
    if (data.phase === 'awaiting-approval') {
      useStore
        .getState()
        .updateMessage(msgId, { awaitingApproval: { requestId } });
      append(
        '\n\n⏸ **Ожидание подтверждения пользователя.** Используйте кнопки ниже, либо `/multyplan-approve` / `/multyplan-reject`.\n'
      );
      return;
    }
    if (data.phase === 'plan-edited') {
      append('\n\n_План отредактирован перед отправкой исполнителю._\n');
      return;
    }
    if (data.phase === 'approved') {
      useStore.getState().updateMessage(msgId, {
        awaitingApproval: { requestId, resolved: 'approved' },
      });
      append('\n✅ План утверждён. Запускаю исполнителя…\n');
      return;
    }
    if (data.phase === 'rejected') {
      useStore.getState().updateMessage(msgId, {
        awaitingApproval: { requestId, resolved: 'rejected' },
      });
      append(`\n🛑 ${data.message || 'План отклонён.'}\n`);
      state.finishMessage(msgId);
      state.setStreaming(false);
      off();
      return;
    }
    if (data.phase === 'agent') {
      // Executor agent events (file tool calls)
      if (data.agentKind === 'text' && data.chunk) {
        append(data.chunk);
      } else if (data.agentKind === 'tool_call') {
        const target = data.args?.path ? ` → ${data.args.path}` : '';
        append(`\n\n_🔧 ${data.tool}${target}…_\n`);
      } else if (data.agentKind === 'tool_result') {
        const icon = data.ok ? '✅' : '⚠️';
        const text = data.ok
          ? data.summary
          : `ошибка: ${data.error || data.summary}`;
        append(`_${icon} ${text}_\n`);
        if (
          data.ok &&
          (data.tool === 'edit_file' ||
            data.tool === 'create_file' ||
            data.tool === 'delete_file')
        ) {
          // Best-effort refresh
          useStore.getState().refreshFileTree().catch(() => {});
        }
      }
      return;
    }
    if (data.phase === 'complete') {
      append(`\n\n${data.message || 'Готово.'}\n`);
      state.finishMessage(msgId);
      state.setStreaming(false);
      off();
      return;
    }
    if (data.phase === 'error') {
      append(`\n\n❌ ${data.message}\n`);
      state.finishMessage(msgId, data.message);
      state.setStreaming(false);
      off();
      return;
    }
    // Silence "unused stage" warning
    void currentStage;
  });

  const result = await window.api.multyplan.start({
    brief,
    workspaceRoot,
    requestId,
    config,
  });

  if (!result.ok && result.error && result.error !== 'aborted') {
    state.appendToMessage(msgId, `\n\n❌ ${result.error}`);
    state.finishMessage(msgId, result.error);
    state.setStreaming(false);
    off();
  }
}

export async function approveMultyplan(requestId: string, edits?: string) {
  return window.api.multyplan.approve(requestId, { approved: true, edits });
}

export async function rejectMultyplan(requestId: string) {
  return window.api.multyplan.approve(requestId, { approved: false });
}
