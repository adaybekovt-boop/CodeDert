/**
 * Unified cloud AI provider layer.
 *
 * Supports every OpenAI-compatible API (OpenRouter, Groq, NVIDIA NIM, OpenAI,
 * Gemini (OpenAI-compat endpoint), xAI/Grok, Moonshot/Kimi, DeepSeek,
 * Qwen/DashScope, custom base URL) plus Anthropic's native Messages API.
 *
 * Key principles:
 *   - API keys live ONLY in the OS keychain (keytar), never in electron-store.
 *   - Key validation is the cheapest possible call: GET /models (zero tokens).
 *   - Model lists are cached in electron-store so boot never hits the network.
 *   - Streaming is SSE; every provider funnels into one `streamText` interface
 *     used by both plain chat and the tool-using agent loop.
 */
import type { BrowserWindow } from 'electron';
import Store from 'electron-store';
import { keystore } from './keystore.js';

export type ProviderKind = 'openai' | 'anthropic';

export interface ProviderInfo {
  id: string;
  label: string;
  /** Default base URL. Can be overridden per provider (e.g. moonshot.cn). */
  baseUrl: string;
  kind: ProviderKind;
  keyHint: string;
  keysUrl: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'anthropic',  label: 'Anthropic (Claude)',      baseUrl: 'https://api.anthropic.com',                              kind: 'anthropic', keyHint: 'sk-ant-…',  keysUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openrouter', label: 'OpenRouter',               baseUrl: 'https://openrouter.ai/api/v1',                           kind: 'openai',    keyHint: 'sk-or-v1-…', keysUrl: 'https://openrouter.ai/keys' },
  { id: 'openai',     label: 'OpenAI (ChatGPT)',         baseUrl: 'https://api.openai.com/v1',                              kind: 'openai',    keyHint: 'sk-…',       keysUrl: 'https://platform.openai.com/api-keys' },
  { id: 'gemini',     label: 'Google Gemini',            baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', kind: 'openai',    keyHint: 'AIza…',      keysUrl: 'https://aistudio.google.com/apikey' },
  { id: 'groq',       label: 'Groq',                     baseUrl: 'https://api.groq.com/openai/v1',                         kind: 'openai',    keyHint: 'gsk_…',      keysUrl: 'https://console.groq.com/keys' },
  { id: 'nvidia',     label: 'NVIDIA (build.nvidia.com)', baseUrl: 'https://integrate.api.nvidia.com/v1',                   kind: 'openai',    keyHint: 'nvapi-…',    keysUrl: 'https://build.nvidia.com' },
  { id: 'xai',        label: 'xAI (Grok)',               baseUrl: 'https://api.x.ai/v1',                                    kind: 'openai',    keyHint: 'xai-…',      keysUrl: 'https://console.x.ai' },
  { id: 'moonshot',   label: 'Moonshot (Kimi)',          baseUrl: 'https://api.moonshot.ai/v1',                             kind: 'openai',    keyHint: 'sk-…',       keysUrl: 'https://platform.moonshot.ai/console/api-keys' },
  { id: 'deepseek',   label: 'DeepSeek',                 baseUrl: 'https://api.deepseek.com/v1',                            kind: 'openai',    keyHint: 'sk-…',       keysUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'qwen',       label: 'Qwen (DashScope)',         baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', kind: 'openai',    keyHint: 'sk-…',       keysUrl: 'https://bailian.console.alibabacloud.com' },
  { id: 'custom',     label: 'Custom (OpenAI-compatible)', baseUrl: '',                                                     kind: 'openai',    keyHint: 'любой',      keysUrl: '' },
];

const byId = new Map(PROVIDERS.map((p) => [p.id, p]));

export interface ProviderModel {
  id: string;
  displayName: string;
  provider: string;
}

// Multimodal content packing lives in provider-content.ts (pure, testable).
export type { ContentPart, ChatMessageIn } from './provider-content.js';
import {
  packAnthropicContent,
  packOpenAiContent,
  hasAttachmentParts,
  type ChatMessageIn,
} from './provider-content.js';

interface ProviderStoreShape {
  baseUrlOverrides?: Record<string, string>;
  modelCache?: Record<string, ProviderModel[]>;
}

const store = new Store<ProviderStoreShape>({ name: 'codedert-providers' });

const ANTHROPIC_VERSION = '2023-06-01';
const LIST_TIMEOUT_MS = 15_000;

/** Keystore account per provider. Anthropic keeps its legacy account name. */
function keyAccount(providerId: string): string {
  return providerId === 'anthropic' ? 'anthropic_api_key' : `provider_${providerId}_api_key`;
}

/** Shared with CWM media generation so keys live in exactly one scheme. */
export function providerKeyAccount(providerId: string): string {
  return keyAccount(providerId);
}

/** Effective base URL (override-aware) — shared with CWM media generation. */
export function providerBaseUrl(providerId: string): string {
  return baseUrl(providerId);
}

function baseUrl(providerId: string): string {
  const overrides = (store.get('baseUrlOverrides') || {}) as Record<string, string>;
  const p = byId.get(providerId);
  const url = (overrides[providerId] || p?.baseUrl || '').trim();
  return url.replace(/\/+$/, '');
}

function isHttpUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Strip key material from error text so it never reaches logs/UI. */
function redact(msg: string, key?: string | null): string {
  let out = msg || '';
  if (key && key.length > 6) out = out.split(key).join('[redacted]');
  return out.slice(0, 500);
}

function normalizeModels(providerId: string, raw: any): ProviderModel[] {
  const arr: any[] = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.models) ? raw.models : [];
  const out: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const m of arr) {
    let id: string = typeof m === 'string' ? m : m?.id || m?.name || '';
    if (!id) continue;
    if (providerId === 'gemini') id = id.replace(/^models\//, '');
    if (seen.has(id)) continue;
    seen.add(id);
    const displayName =
      (typeof m?.display_name === 'string' && m.display_name) ||
      (typeof m?.name === 'string' && m.name !== id && !m.name.startsWith('models/') && m.name) ||
      id;
    out.push({ id, displayName: String(displayName), provider: providerId });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

async function fetchModels(providerId: string, key: string): Promise<{ ok: boolean; models?: ProviderModel[]; error?: string }> {
  const p = byId.get(providerId);
  if (!p) return { ok: false, error: `unknown provider: ${providerId}` };
  const base = baseUrl(providerId);
  if (!base || !isHttpUrl(base)) return { ok: false, error: 'base URL не задан или некорректен' };

  try {
    if (p.kind === 'anthropic') {
      const res = await fetch(`${base}/v1/models?limit=1000`, {
        headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ключ отклонён или нет доступа` };
      const data: any = await res.json();
      const models = (data?.data || []).map((m: any) => ({
        id: m.id,
        displayName: m.display_name || m.id,
        provider: providerId,
      }));
      return { ok: true, models };
    }

    // OpenRouter's /models is public — validate the key against /key first.
    if (providerId === 'openrouter') {
      const keyRes = await fetch(`${base}/key`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      });
      if (!keyRes.ok) return { ok: false, error: `HTTP ${keyRes.status}: ключ отклонён` };
    }

    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ключ отклонён или нет доступа` };
    const data = await res.json();
    const models = normalizeModels(providerId, data);
    if (models.length === 0) return { ok: false, error: 'провайдер вернул пустой список моделей' };
    return { ok: true, models };
  } catch (err: any) {
    return { ok: false, error: redact(err?.message || String(err), key) };
  }
}

function cacheModels(providerId: string, models: ProviderModel[]): void {
  const cache = (store.get('modelCache') || {}) as Record<string, ProviderModel[]>;
  cache[providerId] = models;
  store.set('modelCache', cache);
}

function cachedModels(providerId: string): ProviderModel[] {
  const cache = (store.get('modelCache') || {}) as Record<string, ProviderModel[]>;
  return cache[providerId] || [];
}

// ── Streaming ────────────────────────────────────────────────

export interface StreamParams {
  providerId: string;
  model: string;
  messages: ChatMessageIn[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  signal: AbortSignal;
  onText: (chunk: string) => void;
  onThinking?: (chunk: string) => void;
}

export interface StreamResult {
  ok: boolean;
  text: string;
  error?: string;
  aborted?: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** Parse an SSE stream, invoking cb for every `data:` JSON payload. */
async function readSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  cb: (data: any) => boolean | void
): Promise<void> {
  // If no chunk arrives for this long, stop reading — avoids silent hangs when
  // a cloud provider stalls mid-stream (e.g. during a tool call generation).
  const STALL_MS = 90_000;
  const MEANINGFUL_IDLE_MS = 60_000;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let lastMeaningfulAt = Date.now();

  type ReadResult = Awaited<ReturnType<typeof reader.read>>;
  function readNext(): Promise<ReadResult> {
    return new Promise((resolve, reject) => {
      stallTimer = setTimeout(
        () => reject(Object.assign(new Error('SSE stream stalled'), { name: 'TimeoutError' })),
        STALL_MS
      );
      reader.read().then(
        (r) => { clearTimeout(stallTimer); resolve(r); },
        (e) => { clearTimeout(stallTimer); reject(e); }
      );
    });
  }

  try {
    while (true) {
      if (signal.aborted) break;
      let result: ReadResult;
      try {
        result = await readNext();
      } catch (err: any) {
        if (err.name === 'TimeoutError') break; // stall — end gracefully
        throw err;
      }
      if (result.done) break;
      buf += decoder.decode(result.value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          if (cb(JSON.parse(payload))) lastMeaningfulAt = Date.now();
        } catch {
          /* skip malformed */
        }
      }
      if (Date.now() - lastMeaningfulAt > MEANINGFUL_IDLE_MS) break;
    }
  } finally {
    clearTimeout(stallTimer);
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Stream one completion from any provider. Resolves with the full text.
 * Abort via `params.signal` is treated as success (partial text returned).
 */
async function streamText(params: StreamParams): Promise<StreamResult> {
  const { providerId, model, messages, system, signal, onText, onThinking } = params;
  const p = byId.get(providerId);
  if (!p) return { ok: false, text: '', error: `unknown provider: ${providerId}` };
  const key = await keystore.get(keyAccount(providerId));
  if (!key) return { ok: false, text: '', error: `API ключ для ${p.label} не задан (Settings → Providers)` };
  const base = baseUrl(providerId);
  if (!base || !isHttpUrl(base)) return { ok: false, text: '', error: 'base URL не задан или некорректен' };

  const maxTokens = clampInt(params.maxTokens, 64, 64_000, 8192);
  const temperature = params.temperature;

  let text = '';
  const usage: { inputTokens?: number; outputTokens?: number } = {};

  try {
    if (p.kind === 'anthropic') {
      const body: any = {
        model,
        max_tokens: maxTokens,
        stream: true,
        messages: messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role, content: packAnthropicContent(m.content) })),
      };
      if (system) body.system = system;
      if (temperature !== undefined) body.temperature = temperature;

      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok || !res.body) {
        const errText = await safeReadError(res);
        return { ok: false, text: '', error: redact(`HTTP ${res.status}${errText ? `: ${errText}` : ''}`, key) };
      }
      await readSse(res.body, signal, (data) => {
        if (data.type === 'content_block_delta') {
          if (data.delta?.type === 'text_delta' && data.delta.text) {
            text += data.delta.text;
            onText(data.delta.text);
            return true;
          } else if (data.delta?.type === 'thinking_delta' && data.delta.thinking && onThinking) {
            onThinking(data.delta.thinking);
            return true;
          }
        } else if (data.type === 'message_delta' && data.usage) {
          usage.outputTokens = data.usage.output_tokens;
        } else if (data.type === 'message_start' && data.message?.usage) {
          usage.inputTokens = data.message.usage.input_tokens;
        }
      });
      return { ok: true, text, usage };
    }

    // OpenAI-compatible providers.
    const finalMessages: ChatMessageIn[] = system
      ? [{ role: 'system', content: system }, ...messages.filter((m) => m.role !== 'system')]
      : messages;
    let packedMessages: { role: string; content: unknown }[];
    try {
      packedMessages = finalMessages.map((m) => ({ role: m.role, content: packOpenAiContent(m.content) }));
    } catch (packErr: any) {
      return { ok: false, text: '', error: String(packErr?.message || packErr) };
    }
    const body: any = { model, messages: packedMessages, stream: true, max_tokens: maxTokens };
    if (temperature !== undefined) body.temperature = temperature;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      Authorization: `Bearer ${key}`,
    };
    if (providerId === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/codedert';
      headers['X-Title'] = 'CodeDert';
    }

    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      const errText = await safeReadError(res);
      const visionHint =
        (res.status === 400 || res.status === 422) && hasAttachmentParts(messages)
          ? ' Похоже, эта модель не принимает вложения — выберите мультимодальную (vision) модель.'
          : '';
      return {
        ok: false,
        text: '',
        error: redact(`HTTP ${res.status}${errText ? `: ${errText}` : ''}${visionHint}`, key),
      };
    }
    await readSse(res.body, signal, (data) => {
      const delta = data?.choices?.[0]?.delta;
      if (delta?.content) {
        text += delta.content;
        onText(delta.content);
        return true;
      }
      // DeepSeek-R1 / Qwen reasoning models stream thoughts separately.
      const reasoning = delta?.reasoning_content || delta?.reasoning;
      if (reasoning && onThinking) {
        onThinking(reasoning);
        return true;
      }
      if (data?.usage) {
        usage.inputTokens = data.usage.prompt_tokens;
        usage.outputTokens = data.usage.completion_tokens;
      }
    });
    return { ok: true, text, usage };
  } catch (err: any) {
    if (err?.name === 'AbortError' || signal.aborted) {
      return { ok: true, text, aborted: true };
    }
    return { ok: false, text, error: redact(err?.message || String(err), key) };
  }
}

async function safeReadError(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 300);
  } catch {
    return '';
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// ── Chat (renderer-facing, with chunk events) ────────────────

const activeRequests = new Map<string, AbortController>();

export const providers = {
  registry(): ProviderInfo[] {
    return PROVIDERS;
  },

  streamText,

  async status(): Promise<
    { id: string; label: string; kind: ProviderKind; keyHint: string; keysUrl: string; baseUrl: string; hasKey: boolean; modelCount: number }[]
  > {
    const out = [];
    for (const p of PROVIDERS) {
      const key = await keystore.get(keyAccount(p.id));
      out.push({
        id: p.id,
        label: p.label,
        kind: p.kind,
        keyHint: p.keyHint,
        keysUrl: p.keysUrl,
        baseUrl: baseUrl(p.id),
        hasKey: !!key,
        modelCount: cachedModels(p.id).length,
      });
    }
    return out;
  },

  async hasKey(providerId: string): Promise<boolean> {
    return !!(await keystore.get(keyAccount(providerId)));
  },

  /**
   * Store the key, then perform the *minimal* validation the product spec
   * asks for: a single GET /models. No tokens are spent. On success the
   * model list is cached and returned.
   */
  async setKey(
    providerId: string,
    key: string
  ): Promise<{ ok: boolean; error?: string; models?: ProviderModel[] }> {
    const p = byId.get(providerId);
    if (!p) return { ok: false, error: `unknown provider: ${providerId}` };
    const trimmed = (key || '').trim();
    if (!trimmed || trimmed.length < 8) return { ok: false, error: 'ключ слишком короткий' };

    const verify = await fetchModels(providerId, trimmed);
    if (!verify.ok) return { ok: false, error: verify.error };

    await keystore.set(keyAccount(providerId), trimmed);
    cacheModels(providerId, verify.models || []);
    return { ok: true, models: verify.models };
  },

  async clearKey(providerId: string): Promise<void> {
    try {
      await keystore.delete(keyAccount(providerId));
    } catch {
      /* not set */
    }
    cacheModels(providerId, []);
  },

  /** Cached models (no network). */
  cachedModels,

  /** Refresh model list from the provider (requires stored key). */
  async refreshModels(
    providerId: string
  ): Promise<{ ok: boolean; error?: string; models?: ProviderModel[] }> {
    const key = await keystore.get(keyAccount(providerId));
    if (!key) return { ok: false, error: 'ключ не задан' };
    const res = await fetchModels(providerId, key);
    if (res.ok) cacheModels(providerId, res.models || []);
    return res;
  },

  /** All cached models across providers that currently have a key. */
  async allModels(): Promise<ProviderModel[]> {
    const out: ProviderModel[] = [];
    for (const p of PROVIDERS) {
      const key = await keystore.get(keyAccount(p.id));
      if (!key) continue;
      out.push(...cachedModels(p.id));
    }
    return out;
  },

  setBaseUrl(providerId: string, url: string): { ok: boolean; error?: string } {
    const p = byId.get(providerId);
    if (!p) return { ok: false, error: 'unknown provider' };
    const trimmed = (url || '').trim();
    if (trimmed && !isHttpUrl(trimmed)) return { ok: false, error: 'нужен http(s) URL' };
    const overrides = (store.get('baseUrlOverrides') || {}) as Record<string, string>;
    if (trimmed) overrides[providerId] = trimmed;
    else delete overrides[providerId];
    store.set('baseUrlOverrides', overrides);
    return { ok: true };
  },

  /**
   * Streaming chat for the renderer. Emits 'providers:chunk' events:
   *   { requestId, chunk, type: 'text'|'thinking', done, error?, usage? }
   */
  async chat(
    params: {
      providerId: string;
      model: string;
      messages: ChatMessageIn[];
      system?: string;
      requestId: string;
      maxTokens?: number;
      temperature?: number;
    },
    win: BrowserWindow
  ): Promise<{ ok: boolean; text?: string; error?: string }> {
    const { requestId } = params;
    const controller = new AbortController();
    activeRequests.set(requestId, controller);

    const emit = (payload: any) => {
      if (!win.isDestroyed()) win.webContents.send('providers:chunk', { requestId, ...payload });
    };

    try {
      const res = await streamText({
        providerId: params.providerId,
        model: params.model,
        messages: params.messages,
        system: params.system,
        maxTokens: params.maxTokens,
        temperature: params.temperature,
        signal: controller.signal,
        onText: (chunk) => emit({ chunk, type: 'text', done: false }),
        onThinking: (chunk) => emit({ chunk, type: 'thinking', done: false }),
      });
      emit({ chunk: '', type: 'text', done: true, error: res.ok ? undefined : res.error, usage: res.usage });
      return { ok: res.ok, text: res.text, error: res.error };
    } finally {
      activeRequests.delete(requestId);
    }
  },

  abort(requestId: string): boolean {
    const c = activeRequests.get(requestId);
    if (c) {
      c.abort();
      activeRequests.delete(requestId);
      return true;
    }
    return false;
  },
};
