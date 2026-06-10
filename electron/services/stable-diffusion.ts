import fs from 'node:fs/promises';
import path from 'node:path';
import { getActiveWorkspaceRoot } from './workspace.js';
import { safeResolveInWorkspace } from './path-safety.js';
import { appSettings } from './settings.js';

function sdUrl(): string {
  return appSettings.get().provider.sd.baseUrl.replace(/\/+$/, '');
}

export interface Txt2ImgParams {
  prompt: string;
  negative_prompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  sampler?: string;
  seed?: number;
  cfg_scale?: number;
}

export interface StableDiffusionModel {
  title: string;
  model_name: string;
  hash?: string;
  filename?: string;
}

export const stableDiffusion = {
  async health(): Promise<{ ok: boolean; error?: string; models?: StableDiffusionModel[]; currentModel?: string }> {
    try {
      const res = await fetch(`${sdUrl()}/sdapi/v1/sd-models`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const models = (await res.json()) as StableDiffusionModel[];
      let currentModel: string | undefined;
      try {
        const optionsRes = await fetch(`${sdUrl()}/sdapi/v1/options`, {
          signal: AbortSignal.timeout(2000),
        });
        if (optionsRes.ok) {
          const options: any = await optionsRes.json();
          currentModel = options.sd_model_checkpoint;
        }
      } catch {
        // A1111 is alive even if options endpoint hiccups.
      }
      return { ok: true, models, currentModel };
    } catch (err: any) {
      return {
        ok: false,
        error:
          err.message ||
          'Stable Diffusion (AUTOMATIC1111) не отвечает на localhost:7860. Запустите webui с флагом --api',
      };
    }
  },

  async listModels(): Promise<{ ok: boolean; models?: StableDiffusionModel[]; currentModel?: string; error?: string }> {
    const health = await this.health();
    if (!health.ok) return { ok: false, error: health.error };
    return { ok: true, models: health.models || [], currentModel: health.currentModel };
  },

  async setModel(title: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${sdUrl()}/sdapi/v1/options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sd_model_checkpoint: title }),
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) };
    }
  },

  async txt2img(params: Txt2ImgParams): Promise<{
    ok: boolean;
    images?: string[]; // base64 PNG
    info?: any;
    error?: string;
  }> {
    try {
      const body = {
        prompt: `${params.prompt}, cinematic lighting, high detail, sharp focus, professional color grading`,
        negative_prompt:
          params.negative_prompt ||
          'low quality, blurry, jpeg artifacts, watermark, text, signature, deformed hands, bad anatomy',
        width: params.width || 1024,
        height: params.height || 1024,
        steps: params.steps || 28,
        sampler_name: params.sampler || 'DPM++ 2M Karras',
        seed: params.seed ?? -1,
        cfg_scale: params.cfg_scale || 6,
        batch_size: 1,
        n_iter: 1,
      };
      const res = await fetch(`${sdUrl()}/sdapi/v1/txt2img`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data: any = await res.json();
      return { ok: true, images: data.images || [], info: data.info };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  },

  async saveImage(
    base64: string,
    savePath: string
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    // Constrain writes to the active workspace — the renderer supplies this
    // path (possibly from AI/slash-command args), so it must be re-validated
    // in the main process to prevent arbitrary file writes.
    const check = safeResolveInWorkspace(savePath, getActiveWorkspaceRoot());
    if (!check.ok) return { ok: false, error: check.error };
    const target = check.absolute!;
    try {
      // Strip "data:image/png;base64," if present
      const clean = base64.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(clean, 'base64');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, buf);
      return { ok: true, path: target };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  },
};
