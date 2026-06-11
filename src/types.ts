// Global type augmentations for the renderer.

import type { Api } from '../electron/preload';

declare global {
  interface Window {
    api: Api;
  }
}

/** A single tool invocation rendered as a structured block in the chat. */
export interface ToolEvent {
  id: string;
  /** Tool name as reported by the agent loop (read_file, edit_file, run, …). */
  tool: string;
  /** File path or command the tool targets, if known. */
  target?: string;
  status: 'running' | 'done' | 'error';
  /** Result summary or error text. */
  output?: string;
  /** content.length at the moment the call started — anchors the block between prose chunks. */
  anchor: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolEvents?: ToolEvent[];
  thinking?: string;
  model?: string;
  timestamp: number;
  streaming?: boolean;
  error?: string;
  /** Set when a /multyplan session is paused waiting for user approval. */
  awaitingApproval?: { requestId: string; resolved?: 'approved' | 'rejected' };
  /** Set while an /ultrathink analysis-only session is running. */
  ultrathinkRequestId?: string;
}

export interface FileNode {
  id: string;
  name: string;
  path: string;
  isDir: boolean;
  children?: FileNode[];
}

export interface OpenFile {
  path: string;
  name: string;
  content: string;
  dirty: boolean;
  language: string;
}

export type ChatMode = 'code' | 'design' | 'cdesign';

/** 'ollama' = local. Everything else is a cloud provider (see providers.ts). */
export type ModelProvider =
  | 'ollama'
  | 'anthropic'
  | 'openrouter'
  | 'openai'
  | 'gemini'
  | 'groq'
  | 'nvidia'
  | 'xai'
  | 'moonshot'
  | 'deepseek'
  | 'qwen'
  | 'custom';

export const PROVIDER_LABELS: Record<string, string> = {
  ollama: 'Local',
  anthropic: 'Claude',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  gemini: 'Gemini',
  groq: 'Groq',
  nvidia: 'NVIDIA',
  xai: 'Grok',
  moonshot: 'Kimi',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  custom: 'Custom',
};

export interface ModelChoice {
  id: string;          // for ollama: "qwen2.5-coder:7b". For anthropic: "claude-opus-4-7"
  displayName: string;
  provider: ModelProvider;
}

export {};
