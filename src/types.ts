// Global type augmentations for the renderer.

import type { Api } from '../electron/preload';

declare global {
  interface Window {
    api: Api;
  }
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
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
