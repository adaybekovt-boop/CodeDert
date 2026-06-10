import Anthropic from '@anthropic-ai/sdk';
import type { BrowserWindow } from 'electron';
import { keystore } from './keystore.js';

const KEY_ACCOUNT = 'anthropic_api_key';
const DEFAULT_MODEL = 'claude-opus-4-7';

let cachedClient: Anthropic | null = null;
let cachedKey: string | null = null;

async function getClient(): Promise<Anthropic | null> {
  const key = await keystore.get(KEY_ACCOUNT);
  if (!key) return null;
  if (cachedClient && cachedKey === key) return cachedClient;
  cachedClient = new Anthropic({ apiKey: key });
  cachedKey = key;
  return cachedClient;
}

export const anthropic = {
  async hasKey(): Promise<boolean> {
    const key = await keystore.get(KEY_ACCOUNT);
    return !!key && key.length > 10;
  },

  async setKey(key: string): Promise<{ ok: boolean; error?: string }> {
    if (!key || !key.trim().startsWith('sk-ant-')) {
      return { ok: false, error: 'Невалидный ключ. Должен начинаться с sk-ant-' };
    }
    await keystore.set(KEY_ACCOUNT, key.trim());
    cachedClient = null;
    cachedKey = null;
    return { ok: true };
  },

  async clearKey(): Promise<void> {
    await keystore.delete(KEY_ACCOUNT);
    cachedClient = null;
    cachedKey = null;
  },

  /**
   * Minimal key validation: one GET /v1/models. Zero tokens spent.
   * (The old implementation sent a real message — it cost money on every
   * settings save and could hit rate limits.)
   */
  async testKey(): Promise<{ ok: boolean; error?: string; model?: string }> {
    const key = await keystore.get(KEY_ACCOUNT);
    if (!key) return { ok: false, error: 'API ключ не задан' };
    try {
      const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ключ отклонён` };
      const data: any = await res.json();
      return { ok: true, model: data?.data?.[0]?.id };
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) };
    }
  },

  /**
   * Stream chat with Claude. Emits chunks via webContents.send('anthropic:chunk', ...).
   * Returns the full final message on completion.
   */
  async chat(
    params: {
      model?: string;
      messages: any[];
      system?: string;
      requestId: string;
      adaptiveThinking?: boolean;
      effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      maxTokens?: number;
    },
    win: BrowserWindow
  ): Promise<{ ok: boolean; text?: string; error?: string }> {
    const client = await getClient();
    if (!client) {
      win.webContents.send('anthropic:chunk', {
        requestId: params.requestId,
        chunk: '',
        type: 'text',
        done: true,
        error: 'Claude API ключ не задан. Откройте Settings → Anthropic API key.',
      });
      return { ok: false, error: 'no api key' };
    }

    const {
      model = DEFAULT_MODEL,
      messages,
      system,
      requestId,
      adaptiveThinking = true,
      effort = 'high',
      maxTokens = 16000,
    } = params;

    try {
      const createParams: any = {
        model,
        max_tokens: maxTokens,
        messages,
      };
      if (system) createParams.system = system;
      if (adaptiveThinking) {
        createParams.thinking = { type: 'adaptive', display: 'summarized' };
      }
      // effort goes under output_config
      createParams.output_config = { effort };

      const stream = client.messages.stream(createParams);

      let fullText = '';
      stream.on('text', (delta: string) => {
        fullText += delta;
        win.webContents.send('anthropic:chunk', {
          requestId,
          chunk: delta,
          type: 'text',
          done: false,
        });
      });

      // Capture thinking blocks if any
      stream.on('contentBlock', (block: any) => {
        if (block.type === 'thinking' && block.thinking) {
          win.webContents.send('anthropic:chunk', {
            requestId,
            chunk: block.thinking,
            type: 'thinking',
            done: false,
          });
        }
      });

      const finalMessage = await stream.finalMessage();
      win.webContents.send('anthropic:chunk', {
        requestId,
        chunk: '',
        type: 'text',
        done: true,
        usage: finalMessage.usage,
      });

      return { ok: true, text: fullText };
    } catch (err: any) {
      const msg = err?.message || String(err);
      win.webContents.send('anthropic:chunk', {
        requestId,
        chunk: '',
        type: 'text',
        done: true,
        error: msg,
      });
      return { ok: false, error: msg };
    }
  },

  /**
   * Non-streaming one-shot — used by opus-plan to get a structured response.
   */
  async oneshot(params: {
    model?: string;
    messages: any[];
    system?: string;
    maxTokens?: number;
    adaptiveThinking?: boolean;
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  }): Promise<{ ok: boolean; text?: string; error?: string }> {
    const client = await getClient();
    if (!client) return { ok: false, error: 'API key not set' };

    const {
      model = DEFAULT_MODEL,
      messages,
      system,
      maxTokens = 16000,
      adaptiveThinking = true,
      effort = 'xhigh',
    } = params;

    try {
      const createParams: any = {
        model,
        max_tokens: maxTokens,
        messages,
      };
      if (system) createParams.system = system;
      if (adaptiveThinking) createParams.thinking = { type: 'adaptive', display: 'omitted' };
      createParams.output_config = { effort };

      const stream = client.messages.stream(createParams);
      const finalMessage = await stream.finalMessage();
      const textBlock = finalMessage.content.find((b: any) => b.type === 'text') as any;
      return { ok: true, text: textBlock?.text || '' };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  },
};
