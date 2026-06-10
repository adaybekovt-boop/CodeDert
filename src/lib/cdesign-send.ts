/**
 * Bridge module: lets non-component code (cdesign-runner) trigger a chat send
 * with overrides without going through the React hook directly.
 *
 * It uses the same logic as useChat.send: builds context, picks anthropic /
 * agent / ollama path, places the assistant placeholder, streams events into
 * the active message via the same listeners that useChat installed at mount.
 *
 * IMPORTANT: this only works when ChatPanel (which mounts useChat) has been
 * rendered at least once — useChat installs the listeners and tracks the
 * active requestId via the registry below.
 */

import { useStore } from '../hooks/useStore';
import { genId, relativePath } from './utils';
import { CODE_SYSTEM_PROMPT } from './prompts';
import type { ChatMessage, FileNode, OpenFile } from '../types';

// A tiny registry the useChat hook updates so external callers know which
// request is in flight. Used by cdesign-runner to wire up cancellation.
export const chatRegistry: {
  setActive: ((requestId: string | null, mode: 'agent' | 'ollama' | 'anthropic' | 'providers' | null) => void) | null;
  getActive: () => { requestId: string | null; mode: 'agent' | 'ollama' | 'anthropic' | 'providers' | null };
} = {
  setActive: null,
  getActive: () => ({ requestId: null, mode: null }),
};

interface ExternalSendOptions {
  text: string;
  echoText?: string;
  systemOverride?: string;
  systemSuffix?: string;
  forceChat?: boolean;
  hideUserMessage?: boolean;
}

function buildTreeLines(node: FileNode, root: string | null, depth = 0, lines: string[] = []): string[] {
  if (lines.length >= 180) return lines;
  const rel = relativePath(node.path, root);
  const label = depth === 0 ? rel || node.name : `${'  '.repeat(depth)}${node.isDir ? '▸' : '-'} ${node.name}`;
  lines.push(label);
  if (node.isDir && node.children && depth < 5) {
    for (const child of node.children) {
      buildTreeLines(child, root, depth + 1, lines);
      if (lines.length >= 180) break;
    }
  }
  return lines;
}

function fileBlock(file: OpenFile, workspaceRoot: string | null, title: string, maxBytes: number): string {
  const rel = relativePath(file.path, workspaceRoot);
  const content =
    file.content.length > maxBytes
      ? `${file.content.slice(0, maxBytes)}\n\n/* ...file truncated for context... */`
      : file.content;
  return `\n\n[${title}: ${rel}]\n\`\`\`${file.language}\n${content}\n\`\`\``;
}

export async function useChatExternal(opts: ExternalSendOptions) {
  const state = useStore.getState();
  const { selectedModel, openFiles, activeFilePath, workspaceRoot, fileTree } = state;
  if (!selectedModel) {
    state.addMessage({
      id: genId(),
      role: 'assistant',
      content: '⚠️ Select a model first.',
      timestamp: Date.now(),
    });
    return;
  }
  const perFileBudget = openFiles.length > 4 ? 8000 : 16000;

  let contextBlock = '';
  if (workspaceRoot) {
    contextBlock += `\n\n[Project]\nRoot: ${workspaceRoot}`;
    if (fileTree) {
      contextBlock += `\n\n[File tree]\n${buildTreeLines(fileTree, workspaceRoot).join('\n')}`;
    }
  } else {
    contextBlock += '\n\n[Project]\nNo project folder is open.';
  }
  if (activeFilePath) {
    const af = openFiles.find((f) => f.path === activeFilePath);
    if (af) contextBlock += fileBlock(af, workspaceRoot, 'Active file', perFileBudget);
  }
  const extraOpenFiles = openFiles.filter((f) => f.path !== activeFilePath).slice(0, 4);
  for (const file of extraOpenFiles) {
    contextBlock += fileBlock(file, workspaceRoot, 'Open file', perFileBudget);
  }

  if (!opts.hideUserMessage) {
    state.addMessage({
      id: genId(),
      role: 'user',
      content: opts.echoText ?? opts.text,
      timestamp: Date.now(),
    });
  }

  const history = state.messages
    .filter((m) => m.role !== 'system' && !m.error)
    .map((m) => ({ role: m.role, content: m.content }));
  history.push({ role: 'user', content: opts.text + contextBlock });

  let systemPrompt = opts.systemOverride ?? CODE_SYSTEM_PROMPT;
  if (opts.systemSuffix) systemPrompt = `${systemPrompt}\n\n${opts.systemSuffix}`;

  const assistantMsg: ChatMessage = {
    id: genId(),
    role: 'assistant',
    content: '',
    thinking: '',
    model: selectedModel.displayName,
    timestamp: Date.now(),
    streaming: true,
  };
  state.addMessage(assistantMsg);
  state.setStreaming(true);

  const requestId = genId();
  // Let useChat know about this request so its onChunk/onEvent listeners
  // (already installed at hook mount) route into the assistant message.
  if (selectedModel.provider === 'anthropic') {
    chatRegistry.setActive?.(requestId, 'anthropic');
    await window.api.anthropic.chat({
      model: selectedModel.id,
      messages: history,
      system: systemPrompt,
      requestId,
      adaptiveThinking: true,
      effort: 'high',
    });
  } else if (!opts.forceChat && workspaceRoot) {
    chatRegistry.setActive?.(requestId, 'agent');
    await window.api.agent.chat({
      model: selectedModel.id,
      messages: history as any,
      system: systemPrompt,
      workspaceRoot,
      requestId,
    });
  } else {
    chatRegistry.setActive?.(requestId, 'ollama');
    await window.api.ollama.chat({
      model: selectedModel.id,
      messages: history,
      system: systemPrompt,
      requestId,
    });
  }
}
