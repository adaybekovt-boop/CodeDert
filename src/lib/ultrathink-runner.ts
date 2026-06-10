import { useStore } from '../hooks/useStore';
import { genId } from './utils';

type ModelChoice = 'auto' | 'deepseek' | 'gemma';

let activeUltrathinkRequestId: string | null = null;

export function parseUltrathinkCommand(command: string): ModelChoice {
  if (command === '/ultrathink:deepseek') return 'deepseek';
  if (command === '/ultrathink:gemma') return 'gemma';
  return 'auto';
}

export async function runUltrathink(task: string, modelChoice: ModelChoice) {
  const state = useStore.getState();
  const { workspaceRoot, addMessage } = state;

  if (!task.trim()) {
    addMessage({
      id: genId(),
      role: 'assistant',
      content: 'Usage: `/ultrathink <task>` or `/ultrathink:deepseek <task>` or `/ultrathink:gemma <task>`',
      timestamp: Date.now(),
    });
    return;
  }

  if (!workspaceRoot) {
    addMessage({
      id: genId(),
      role: 'assistant',
      content: 'Open a project folder before running `/ultrathink`.',
      timestamp: Date.now(),
    });
    return;
  }

  addMessage({
    id: genId(),
    role: 'user',
    content: modelChoice === 'auto' ? `/ultrathink ${task}` : `/ultrathink:${modelChoice} ${task}`,
    timestamp: Date.now(),
  });

  const config = await window.api.ultrathink.getConfig();
  const requestId = genId();
  activeUltrathinkRequestId = requestId;
  state.setStreaming(true);

  const msgId = genId();
  addMessage({
    id: msgId,
    role: 'assistant',
    content: `# Ultrathink\n\nMode: analysis only. No files will be modified.\n\nModel selection: \`${modelChoice}\`\n\n`,
    timestamp: Date.now(),
    streaming: true,
    ultrathinkRequestId: requestId,
  });

  const append = (chunk: string) => useStore.getState().appendToMessage(msgId, chunk);
  const finish = (error?: string) => {
    const latest = useStore.getState();
    latest.finishMessage(msgId, error);
    latest.setStreaming(false);
    latest.updateMessage(msgId, { ultrathinkRequestId: undefined });
    activeUltrathinkRequestId = null;
    off();
  };

  const off = window.api.ultrathink.onProgress((data: any) => {
    if (data.requestId !== requestId) return;

    if (data.phase === 'start') {
      append(`**Active model:** \`${data.model}\`\n\n`);
      return;
    }
    if (data.phase === 'scan') {
      append(`\n## Scanning\n${data.message || 'Scanning repository...'}\n`);
      return;
    }
    if (data.phase === 'scan-progress') {
      append(
        `\n${data.message || 'Building dependency graph...'}\nAnalyzed files: ${data.analyzedFiles}/${data.totalFiles}\n`
      );
      return;
    }
    if (data.phase === 'context-ready') {
      append(
        `\n## Repository Summary\n${data.repositorySummary}\n\nAnalyzed files: ${data.analyzedFiles}/${data.totalFiles}\n`
      );
      return;
    }
    if (data.phase === 'reasoning') {
      append(`\n## Reasoning\n${data.message || 'Analyzing architecture...'}\n\n`);
      return;
    }
    if (data.phase === 'repair') {
      append(`\n\n## Validation Repair\n${data.message}\n\n`);
      return;
    }
    if (data.phase === 'chunk') {
      return;
    }
    if (data.phase === 'complete') {
      append(
        `\n\n---\n\n${data.report}\n\n---\n\n## Analysis Complete\nActive model: \`${data.model}\`\nAnalyzed files: ${data.analyzedFiles}\nConfidence: ${
          data.confidence == null ? 'unknown' : Math.round(data.confidence * 100) + '%'
        }\n`
      );
      finish();
      return;
    }
    if (data.phase === 'cancelled') {
      append(`\n\nAnalysis cancelled.\n`);
      finish();
      return;
    }
    if (data.phase === 'error') {
      append(`\n\nError: ${data.message}\n`);
      finish(data.message);
    }
  });

  const result = await window.api.ultrathink.start({
    task,
    workspaceRoot,
    requestId,
    modelChoice,
    config,
  });

  if (!result.ok && result.error && activeUltrathinkRequestId === requestId) {
    append(`\n\nError: ${result.error}\n`);
    finish(result.error);
  }
}

export async function cancelUltrathink(): Promise<boolean> {
  if (!activeUltrathinkRequestId) return false;
  const requestId = activeUltrathinkRequestId;
  activeUltrathinkRequestId = null;
  return window.api.ultrathink.cancel(requestId);
}
