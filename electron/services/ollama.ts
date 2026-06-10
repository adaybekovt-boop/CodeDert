import type { BrowserWindow } from 'electron';
import { appSettings } from './settings.js';
import { ollamaBus } from './ollama-bus.js';

function ollamaUrl(): string {
  return appSettings.get().provider.ollama.baseUrl.replace(/\/+$/, '');
}

export interface OllamaModel {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// Tracks in-flight requests so we can abort them
const activeRequests = new Map<string, AbortController>();

export const ollama = {
  async health(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const res = await fetch(`${ollamaUrl()}/api/version`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data: any = await res.json();
      return { ok: true, version: data.version };
    } catch (err: any) {
      return {
        ok: false,
        error: err.message || `Ollama not responding at ${ollamaUrl()}`,
      };
    }
  },

  async list(): Promise<OllamaModel[]> {
    try {
      const res = await fetch(`${ollamaUrl()}/api/tags`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: any = await res.json();
      return data.models || [];
    } catch (err) {
      console.error('ollama.list error:', err);
      return [];
    }
  },

  async pull(
    model: string,
    onProgress: (status: string, percent?: number) => void
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${ollamaUrl()}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model, stream: true }),
      });
      if (!res.ok || !res.body) {
        return { ok: false, error: `HTTP ${res.status}` };
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            const status = data.status || '';
            let percent: number | undefined;
            if (data.total && data.completed) {
              percent = Math.round((data.completed / data.total) * 100);
            }
            onProgress(status, percent);
          } catch {
            // Skip malformed lines
          }
        }
      }

      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  },

  async testModel(model: string): Promise<{ ok: boolean; text?: string; error?: string }> {
    try {
      const res = await fetch(`${ollamaUrl()}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          keep_alive: '10m',
          options: {
            num_predict: 96,
            temperature: 0,
          },
          prompt:
            'Return only one short sentence. Confirm you can help review and write TypeScript code.',
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data: any = await res.json();
      const text = String(data.response || '').trim();
      if (!text) return { ok: false, error: 'Model returned an empty response' };
      return { ok: true, text };
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) };
    }
  },

  async chat(
    params: {
      model: string;
      messages: OllamaMessage[];
      system?: string;
      requestId: string;
      /** Pass 0 to make Ollama unload the model after this response. */
      keepAlive?: number | string;
      /** Sampling overrides. */
      temperature?: number;
      maxOutputTokens?: number;
      contextWindow?: number;
    },
    win: BrowserWindow | null
  ): Promise<{ ok: boolean; error?: string }> {
    const { model, messages, system, requestId, keepAlive, temperature, maxOutputTokens, contextWindow } = params;
    const controller = new AbortController();
    activeRequests.set(requestId, controller);

    const emit = (ev: { chunk: string; done: boolean; error?: string; aborted?: boolean }) => {
      ollamaBus.emit({ requestId, ...ev });
      if (win && !win.isDestroyed()) {
        win.webContents.send('ollama:chunk', { requestId, ...ev });
      }
    };

    try {
      const finalMessages: OllamaMessage[] = system
        ? [{ role: 'system', content: system }, ...messages]
        : messages;

      const tuning = appSettings.get().tuning;
      const body: Record<string, any> = {
        model,
        messages: finalMessages,
        stream: true,
        options: {
          temperature: temperature ?? tuning.temperature,
          num_predict: maxOutputTokens ?? tuning.maxOutputTokens,
          num_ctx: contextWindow ?? tuning.contextWindow,
        },
      };
      const ka = keepAlive ?? tuning.keepAliveSeconds;
      if (ka !== undefined) body.keep_alive = ka;

      const res = await fetch(`${ollamaUrl()}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        emit({ chunk: '', done: true, error: `HTTP ${res.status}` });
        activeRequests.delete(requestId);
        return { ok: false, error: `HTTP ${res.status}` };
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            const chunk = data.message?.content || '';
            const isDone = !!data.done;
            if (chunk || isDone) {
              emit({ chunk, done: isDone });
            }
          } catch {
            // skip malformed line
          }
        }
      }

      // Final done signal (guarantees subscribers wake up even if stream
      // closes without an explicit done message).
      emit({ chunk: '', done: true });
      activeRequests.delete(requestId);
      return { ok: true };
    } catch (err: any) {
      activeRequests.delete(requestId);
      if (err.name === 'AbortError') {
        emit({ chunk: '', done: true, aborted: true });
        return { ok: true };
      }
      emit({ chunk: '', done: true, error: err.message });
      return { ok: false, error: err.message };
    }
  },

  abort(requestId: string): boolean {
    const controller = activeRequests.get(requestId);
    if (controller) {
      controller.abort();
      activeRequests.delete(requestId);
      return true;
    }
    return false;
  },

  /**
   * Force-unload a model from VRAM. Fires a 1-token generate with keep_alive=0.
   * Used by orchestrators to guarantee no two big local models are resident at once.
   */
  async unload(model: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${ollamaUrl()}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: 0, prompt: '' }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) };
    }
  },
};
