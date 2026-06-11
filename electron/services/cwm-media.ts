/**
 * Chat With Model (CWM) — media generation via EXTERNAL provider APIs.
 *
 * Images:  OpenAI (images/generations), xAI/Grok (OpenAI-compatible images
 *          endpoint), Gemini (native generateContent with image output).
 * Video:   OpenAI Sora (/v1/videos, async submit → poll → download),
 *          Gemini Veo (predictLongRunning → operation poll → file download).
 *
 * Keys are read through the SAME keystore accounts the providers layer uses
 * (see providerKeyAccount) — no new storage path, keys never logged, and a
 * provider's key is only ever sent to that provider's own endpoint.
 *
 * Generated files are written ONLY to userData/cwm/media/. "Save as…" goes
 * through a native save dialog; the renderer never supplies a raw path.
 */
import { app, dialog, type BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { keystore } from './keystore.js';
import { providerKeyAccount, providerBaseUrl } from './providers.js';

type ImageProviderId = 'openai' | 'xai' | 'gemini';
type VideoProviderId = 'openai' | 'gemini';

export type CwmJobStatus = 'queued' | 'generating' | 'done' | 'failed' | 'cancelled';

export interface CwmJobEvent {
  jobId: string;
  kind: 'image' | 'video';
  status: CwmJobStatus;
  /** 0..100 when the provider reports it. */
  percent?: number;
  /** Set when status === 'done'. Absolute path inside userData/cwm/media. */
  filePath?: string;
  fileName?: string;
  mediaType?: string;
  /** Image preview for the renderer (images only — videos are too big). */
  base64?: string;
  error?: string;
}

const IMAGE_TIMEOUT_MS = 3 * 60_000;
const VIDEO_POLL_INTERVAL_MS = 10_000;
const VIDEO_TIMEOUT_MS = 12 * 60_000;

const DEFAULT_IMAGE_MODEL: Record<ImageProviderId, string> = {
  openai: 'gpt-image-1',
  xai: 'grok-2-image',
  gemini: 'gemini-2.5-flash-image',
};

const DEFAULT_VIDEO_MODEL: Record<VideoProviderId, string> = {
  openai: 'sora-2',
  gemini: 'veo-3.0-generate-001',
};

function mediaDir(): string {
  return path.join(app.getPath('userData'), 'cwm', 'media');
}

function redact(msg: string, key?: string | null): string {
  let out = String(msg || '');
  if (key && key.length > 6) out = out.split(key).join('[redacted]');
  return out.slice(0, 500);
}

/** Native Gemini API base. The providers registry stores the OpenAI-compat
 *  endpoint (…/v1beta/openai); image/video need the native …/v1beta routes. */
function geminiNativeBase(): string {
  const base = providerBaseUrl('gemini');
  return base.replace(/\/openai$/, '');
}

async function getKey(providerId: string): Promise<string | null> {
  return keystore.get(providerKeyAccount(providerId));
}

async function writeMedia(buf: Buffer, ext: string): Promise<{ filePath: string; fileName: string }> {
  await fs.mkdir(mediaDir(), { recursive: true });
  const fileName = `cwm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const filePath = path.join(mediaDir(), fileName);
  await fs.writeFile(filePath, buf);
  return { filePath, fileName };
}

async function readJsonOrText(res: Response): Promise<{ json?: any; text: string }> {
  const text = await res.text().catch(() => '');
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { text };
  }
}

function friendlyHttpError(status: number, body: string): string {
  const detail = body.slice(0, 240);
  if (status === 401 || status === 403) return `HTTP ${status}: ключ отклонён провайдером. ${detail}`;
  if (status === 404) return `HTTP 404: модель или endpoint не найдены — провайдер может не поддерживать эту генерацию. ${detail}`;
  if (status === 429) return `HTTP 429: лимит запросов/квота исчерпаны. Подождите и повторите. ${detail}`;
  return `HTTP ${status}: ${detail}`;
}

// ── Image generation ─────────────────────────────────────────

async function generateImageOpenAiCompat(
  providerId: 'openai' | 'xai',
  model: string,
  prompt: string,
  size: string | undefined,
  key: string,
  signal: AbortSignal
): Promise<{ b64: string; mediaType: string }> {
  const base = providerBaseUrl(providerId);
  const body: Record<string, unknown> = { model, prompt, n: 1 };
  // xAI rejects `size`/`response_format` mixes that OpenAI accepts — keep
  // each provider's payload minimal and known-good.
  if (providerId === 'openai' && size) body.size = size;
  if (providerId === 'xai') body.response_format = 'b64_json';
  const res = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal,
  });
  const { json, text } = await readJsonOrText(res);
  if (!res.ok) throw new Error(friendlyHttpError(res.status, text));
  const item = json?.data?.[0];
  if (item?.b64_json) return { b64: item.b64_json, mediaType: 'image/png' };
  if (item?.url) {
    const imgRes = await fetch(item.url, { signal });
    if (!imgRes.ok) throw new Error(`не удалось скачать результат: HTTP ${imgRes.status}`);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    return { b64: buf.toString('base64'), mediaType: imgRes.headers.get('content-type') || 'image/png' };
  }
  throw new Error('провайдер вернул ответ без изображения');
}

async function generateImageGemini(
  model: string,
  prompt: string,
  key: string,
  signal: AbortSignal
): Promise<{ b64: string; mediaType: string }> {
  const res = await fetch(`${geminiNativeBase()}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
    }),
    signal,
  });
  const { json, text } = await readJsonOrText(res);
  if (!res.ok) throw new Error(friendlyHttpError(res.status, text));
  const parts: any[] = json?.candidates?.[0]?.content?.parts || [];
  const img = parts.find((p) => p?.inlineData?.data);
  if (!img) throw new Error('Gemini вернул ответ без изображения (возможно, промпт отклонён фильтром)');
  return { b64: img.inlineData.data, mediaType: img.inlineData.mimeType || 'image/png' };
}

// ── Video generation ─────────────────────────────────────────

interface VideoJobState {
  controller: AbortController;
  cancelled: boolean;
}

const activeJobs = new Map<string, VideoJobState>();

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

async function generateVideoOpenAi(
  model: string,
  prompt: string,
  seconds: number | undefined,
  key: string,
  signal: AbortSignal,
  onProgress: (percent?: number) => void
): Promise<Buffer> {
  const base = providerBaseUrl('openai');
  const body: Record<string, unknown> = { model, prompt };
  if (seconds) body.seconds = String(seconds);
  const submit = await fetch(`${base}/videos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal,
  });
  const sub = await readJsonOrText(submit);
  if (!submit.ok) throw new Error(friendlyHttpError(submit.status, sub.text));
  const videoId = sub.json?.id;
  if (!videoId) throw new Error('провайдер не вернул id видео-задачи');

  const deadline = Date.now() + VIDEO_TIMEOUT_MS;
  while (true) {
    if (Date.now() > deadline) throw new Error('таймаут генерации видео (12 мин)');
    await sleep(VIDEO_POLL_INTERVAL_MS, signal);
    const poll = await fetch(`${base}/videos/${videoId}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal,
    });
    const st = await readJsonOrText(poll);
    if (!poll.ok) throw new Error(friendlyHttpError(poll.status, st.text));
    const status = st.json?.status;
    if (typeof st.json?.progress === 'number') onProgress(st.json.progress);
    if (status === 'completed') break;
    if (status === 'failed') {
      throw new Error(`генерация не удалась: ${st.json?.error?.message || 'без деталей'}`);
    }
  }

  const dl = await fetch(`${base}/videos/${videoId}/content`, {
    headers: { Authorization: `Bearer ${key}` },
    signal,
  });
  if (!dl.ok) throw new Error(`не удалось скачать видео: HTTP ${dl.status}`);
  return Buffer.from(await dl.arrayBuffer());
}

async function generateVideoGemini(
  model: string,
  prompt: string,
  key: string,
  signal: AbortSignal,
  onProgress: (percent?: number) => void
): Promise<Buffer> {
  const base = geminiNativeBase();
  const submit = await fetch(`${base}/models/${encodeURIComponent(model)}:predictLongRunning`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ instances: [{ prompt }] }),
    signal,
  });
  const sub = await readJsonOrText(submit);
  if (!submit.ok) throw new Error(friendlyHttpError(submit.status, sub.text));
  const opName = sub.json?.name;
  if (!opName) throw new Error('провайдер не вернул имя операции');

  const deadline = Date.now() + VIDEO_TIMEOUT_MS;
  let op: any;
  while (true) {
    if (Date.now() > deadline) throw new Error('таймаут генерации видео (12 мин)');
    await sleep(VIDEO_POLL_INTERVAL_MS, signal);
    onProgress();
    const poll = await fetch(`${base}/${opName}`, {
      headers: { 'x-goog-api-key': key },
      signal,
    });
    const st = await readJsonOrText(poll);
    if (!poll.ok) throw new Error(friendlyHttpError(poll.status, st.text));
    op = st.json;
    if (op?.done) break;
  }
  if (op?.error) throw new Error(`генерация не удалась: ${op.error.message || 'без деталей'}`);
  const uri =
    op?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ||
    op?.response?.generatedVideos?.[0]?.video?.uri;
  if (!uri) throw new Error('операция завершилась без видео (возможно, промпт отклонён фильтром)');
  const dl = await fetch(uri, { headers: { 'x-goog-api-key': key }, signal });
  if (!dl.ok) throw new Error(`не удалось скачать видео: HTTP ${dl.status}`);
  return Buffer.from(await dl.arrayBuffer());
}

// ── Public service ───────────────────────────────────────────

export const cwmMedia = {
  /** Image-capable providers + whether a key is stored, for the UI picker. */
  async imageProviders(): Promise<{ id: string; label: string; model: string; hasKey: boolean }[]> {
    const defs: { id: ImageProviderId; label: string }[] = [
      { id: 'openai', label: 'OpenAI (gpt-image-1)' },
      { id: 'gemini', label: 'Google Gemini (Nano Banana)' },
      { id: 'xai', label: 'xAI (Grok Image)' },
    ];
    const out = [];
    for (const d of defs) {
      out.push({ ...d, model: DEFAULT_IMAGE_MODEL[d.id], hasKey: !!(await getKey(d.id)) });
    }
    return out;
  },

  async videoProviders(): Promise<{ id: string; label: string; model: string; hasKey: boolean }[]> {
    const defs: { id: VideoProviderId; label: string }[] = [
      { id: 'openai', label: 'OpenAI (Sora 2)' },
      { id: 'gemini', label: 'Google Gemini (Veo 3)' },
    ];
    const out = [];
    for (const d of defs) {
      out.push({ ...d, model: DEFAULT_VIDEO_MODEL[d.id], hasKey: !!(await getKey(d.id)) });
    }
    return out;
  },

  /**
   * Generate one image. Resolves when done/failed; progress (queued →
   * generating → done/failed) is also streamed over 'cwm:media-progress'.
   */
  async generateImage(
    params: { jobId: string; providerId: string; model?: string; prompt: string; size?: string },
    win: BrowserWindow
  ): Promise<CwmJobEvent> {
    const { jobId } = params;
    const providerId = params.providerId as ImageProviderId;
    const emit = (ev: Omit<CwmJobEvent, 'jobId' | 'kind'>) => {
      const full: CwmJobEvent = { jobId, kind: 'image', ...ev };
      if (!win.isDestroyed()) win.webContents.send('cwm:media-progress', full);
      return full;
    };

    if (!['openai', 'xai', 'gemini'].includes(providerId)) {
      return emit({ status: 'failed', error: `провайдер ${params.providerId} не поддерживает генерацию изображений` });
    }
    const prompt = String(params.prompt || '').trim();
    if (!prompt) return emit({ status: 'failed', error: 'пустой промпт' });
    const key = await getKey(providerId);
    if (!key) return emit({ status: 'failed', error: `ключ для ${providerId} не задан (Settings → Providers)` });

    const model = (params.model || DEFAULT_IMAGE_MODEL[providerId]).trim();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
    activeJobs.set(jobId, { controller, cancelled: false });
    emit({ status: 'queued' });
    emit({ status: 'generating' });

    try {
      const result =
        providerId === 'gemini'
          ? await generateImageGemini(model, prompt, key, controller.signal)
          : await generateImageOpenAiCompat(providerId, model, prompt, params.size, key, controller.signal);
      const ext = result.mediaType.includes('jpeg') ? 'jpg' : result.mediaType.includes('webp') ? 'webp' : 'png';
      const { filePath, fileName } = await writeMedia(Buffer.from(result.b64, 'base64'), ext);
      return emit({ status: 'done', filePath, fileName, mediaType: result.mediaType, base64: result.b64 });
    } catch (err: any) {
      const cancelled = activeJobs.get(jobId)?.cancelled || err?.name === 'AbortError';
      return emit(
        cancelled && activeJobs.get(jobId)?.cancelled
          ? { status: 'cancelled' }
          : { status: 'failed', error: redact(err?.message || String(err), key) }
      );
    } finally {
      clearTimeout(timeout);
      activeJobs.delete(jobId);
    }
  },

  /**
   * Generate a video: submit → poll → download. Heavy and slow by nature, so
   * everything is async; the renderer follows 'cwm:media-progress' events.
   */
  async generateVideo(
    params: { jobId: string; providerId: string; model?: string; prompt: string; seconds?: number },
    win: BrowserWindow
  ): Promise<CwmJobEvent> {
    const { jobId } = params;
    const providerId = params.providerId as VideoProviderId;
    const emit = (ev: Omit<CwmJobEvent, 'jobId' | 'kind'>) => {
      const full: CwmJobEvent = { jobId, kind: 'video', ...ev };
      if (!win.isDestroyed()) win.webContents.send('cwm:media-progress', full);
      return full;
    };

    if (!['openai', 'gemini'].includes(providerId)) {
      return emit({ status: 'failed', error: `провайдер ${params.providerId} не поддерживает генерацию видео` });
    }
    const prompt = String(params.prompt || '').trim();
    if (!prompt) return emit({ status: 'failed', error: 'пустой промпт' });
    const key = await getKey(providerId);
    if (!key) return emit({ status: 'failed', error: `ключ для ${providerId} не задан (Settings → Providers)` });

    const model = (params.model || DEFAULT_VIDEO_MODEL[providerId]).trim();
    const controller = new AbortController();
    activeJobs.set(jobId, { controller, cancelled: false });
    emit({ status: 'queued' });
    emit({ status: 'generating', percent: 0 });
    const onProgress = (percent?: number) => emit({ status: 'generating', percent });

    try {
      const buf =
        providerId === 'gemini'
          ? await generateVideoGemini(model, prompt, key, controller.signal, onProgress)
          : await generateVideoOpenAi(model, prompt, params.seconds, key, controller.signal, onProgress);
      const { filePath, fileName } = await writeMedia(buf, 'mp4');
      return emit({ status: 'done', filePath, fileName, mediaType: 'video/mp4' });
    } catch (err: any) {
      const st = activeJobs.get(jobId);
      return emit(
        st?.cancelled || (err?.name === 'AbortError' && st?.cancelled !== false)
          ? { status: 'cancelled' }
          : err?.name === 'AbortError'
          ? { status: 'cancelled' }
          : { status: 'failed', error: redact(err?.message || String(err), key) }
      );
    } finally {
      activeJobs.delete(jobId);
    }
  },

  cancel(jobId: string): boolean {
    const st = activeJobs.get(jobId);
    if (!st) return false;
    st.cancelled = true;
    st.controller.abort();
    return true;
  },

  /** "Save as…" for a generated file. Source must live in our media dir. */
  async saveAs(filePath: string, win: BrowserWindow): Promise<{ ok: boolean; path?: string; error?: string }> {
    const resolved = path.resolve(String(filePath || ''));
    const root = path.resolve(mediaDir());
    if (!resolved.startsWith(root + path.sep)) {
      return { ok: false, error: 'файл вне каталога сгенерированных медиа' };
    }
    try {
      await fs.access(resolved);
    } catch {
      return { ok: false, error: 'файл не найден (возможно, очищен)' };
    }
    const res = await dialog.showSaveDialog(win, { defaultPath: path.basename(resolved) });
    if (res.canceled || !res.filePath) return { ok: false, error: 'cancelled' };
    try {
      await fs.copyFile(resolved, res.filePath);
      return { ok: true, path: res.filePath };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) };
    }
  },

  /** Read a generated media file back as base64 (for <img>/<video> src). */
  async readMedia(filePath: string): Promise<{ ok: boolean; base64?: string; error?: string }> {
    const resolved = path.resolve(String(filePath || ''));
    const root = path.resolve(mediaDir());
    if (!resolved.startsWith(root + path.sep)) return { ok: false, error: 'файл вне каталога медиа' };
    try {
      const buf = await fs.readFile(resolved);
      if (buf.length > 64 * 1024 * 1024) return { ok: false, error: 'файл слишком большой для превью' };
      return { ok: true, base64: buf.toString('base64') };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) };
    }
  },

  /** Delete generated media older than `days` (housekeeping, called on boot). */
  async cleanupOldMedia(days = 30): Promise<void> {
    try {
      const dir = mediaDir();
      const files = await fs.readdir(dir).catch(() => [] as string[]);
      const cutoff = Date.now() - days * 24 * 3600 * 1000;
      for (const f of files) {
        const p = path.join(dir, f);
        try {
          const st = await fs.stat(p);
          if (st.isFile() && st.mtimeMs < cutoff) await fs.unlink(p);
        } catch {
          /* skip */
        }
      }
    } catch {
      /* housekeeping must never crash boot */
    }
  },
};
