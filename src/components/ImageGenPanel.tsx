import { useEffect, useState } from 'react';
import { ImageIcon, Loader2, Download, Copy, AlertCircle, ExternalLink, Sparkles, CheckCircle2, RefreshCw } from 'lucide-react';
import { useStore } from '../hooks/useStore';

interface GeneratedImage {
  id: string;
  base64: string;
  prompt: string;
}

export function ImageGenPanel() {
  const { workspaceRoot } = useStore();
  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('low quality, blurry, jpeg artifacts, watermark, text, signature, bad anatomy, deformed hands');
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [steps, setSteps] = useState(28);
  const [generating, setGenerating] = useState(false);
  const [sdStatus, setSdStatus] = useState<'checking' | 'ok' | 'missing'>('checking');
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [sdModels, setSdModels] = useState<any[]>([]);
  const [currentModel, setCurrentModel] = useState('');
  const [switchingModel, setSwitchingModel] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startMsg, setStartMsg] = useState('');

  // On mount: poll health while SD may be auto-starting, so the panel turns
  // green by itself once the webui finishes loading (no manual refresh needed).
  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    setSdStatus('checking');
    async function tick() {
      if (cancelled) return;
      const r = await window.api.sd.listModels();
      if (cancelled) return;
      if (r.ok) {
        setSdStatus('ok');
        setSdModels(r.models || []);
        setCurrentModel(r.currentModel || '');
        setError(null);
        return; // up — stop polling
      }
      setSdStatus('missing');
      setError(r.error || 'Stable Diffusion недоступен');
      attempts += 1;
      if (attempts < 24) setTimeout(tick, 5000); // keep checking ~2 min while it boots
    }
    tick();
    return () => {
      cancelled = true;
    };
  }, []);

  async function startSd() {
    setStarting(true);
    setError(null);
    setStartMsg('Запускаю Stable Diffusion…');
    const r = await window.api.sd.ensureRunning();
    if (!r.ok) {
      setError(r.error || 'Не удалось запустить webui');
      setStarting(false);
      return;
    }
    if (r.alreadyRunning) {
      setStarting(false);
      setStartMsg('');
      await refreshSd();
      return;
    }
    setStartMsg(
      `Запущено${r.patchedApi ? ' (включил --api)' : ''}. Первый старт SDXL может занять 1–2 минуты…`
    );
    // Poll health until the server answers (or we give up after ~3.5 min).
    const deadline = Date.now() + 210_000;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 4000));
      const h = await window.api.sd.health();
      if (h.ok) {
        setStarting(false);
        setStartMsg('');
        await refreshSd();
        return;
      }
    }
    setStarting(false);
    setStartMsg('');
    setError('webui запускается дольше обычного. Нажми «Обновить» через минуту.');
  }

  async function refreshSd() {
    setSdStatus('checking');
    const r = await window.api.sd.listModels();
    setSdStatus(r.ok ? 'ok' : 'missing');
    if (r.ok) {
      setSdModels(r.models || []);
      setCurrentModel(r.currentModel || '');
      setError(null);
    } else {
      setError(r.error || 'Stable Diffusion недоступен');
    }
  }

  async function switchModel(title: string) {
    setSwitchingModel(true);
    setError(null);
    const res = await window.api.sd.setModel(title);
    setSwitchingModel(false);
    if (!res.ok) {
      setError(res.error || 'Не удалось переключить checkpoint');
      return;
    }
    await refreshSd();
  }

  async function generate() {
    if (!prompt.trim() || generating) return;
    setGenerating(true);
    setError(null);
    const res = await window.api.sd.txt2img({
      prompt,
      negative_prompt: negative,
      width,
      height,
      steps,
    });
    setGenerating(false);
    if (!res.ok || !res.images?.length) {
      setError(res.error || 'Не удалось сгенерировать');
      return;
    }
    const newImg: GeneratedImage = {
      id: `${Date.now()}`,
      base64: res.images[0],
      prompt,
    };
    setImages((prev) => [newImg, ...prev].slice(0, 8));
  }

  async function saveToProject(img: GeneratedImage) {
    if (!workspaceRoot) {
      alert('Откройте папку проекта');
      return;
    }
    const filename = `generated-${img.id}.png`;
    const fullPath = `${workspaceRoot}/assets/${filename}`.replace(/\//g, '\\');
    const res = await window.api.sd.saveImage(img.base64, fullPath);
    if (res.ok) {
      alert(`Сохранено: ${res.path}`);
    } else {
      alert('Ошибка: ' + res.error);
    }
  }

  const [copiedId, setCopiedId] = useState<string | null>(null);
  async function copyMarkdown(img: GeneratedImage) {
    // Full, working data-URI markdown (no truncation — the old version copied
    // a broken "...50 chars..." string that rendered nothing).
    const alt = img.prompt.slice(0, 60).replace(/[[\]]/g, '');
    const md = `![${alt}](data:image/png;base64,${img.base64})`;
    await navigator.clipboard.writeText(md);
    setCopiedId(img.id);
    setTimeout(() => setCopiedId((c) => (c === img.id ? null : c)), 1500);
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-bg-border">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-text-secondary flex items-center gap-2">
          <ImageIcon className="w-3.5 h-3.5" />
          Image Gen (Stable Diffusion)
        </h2>
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-3">
        {sdStatus === 'checking' && (
          <div className="panel p-3 text-xs text-text-secondary flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            Проверяю AUTOMATIC1111 API...
          </div>
        )}

        {sdStatus === 'missing' && (
          <div className="panel bg-amber-500/10 border-amber-500/30 p-3 text-xs">
            <div className="flex items-start gap-2 text-amber-400 mb-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <div className="font-medium mb-1">Stable Diffusion не запущен</div>
                <div className="text-text-secondary">{error}</div>
              </div>
            </div>

            <button onClick={startSd} disabled={starting} className="btn-primary text-xs w-full">
              {starting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              {starting ? 'Запускаю…' : 'Запустить Stable Diffusion'}
            </button>

            {startMsg && (
              <p className="text-text-secondary mt-2 text-[11px] flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                {startMsg}
              </p>
            )}

            <div className="flex gap-1 mt-2">
              <button onClick={refreshSd} className="btn-secondary text-xs flex-1">
                <RefreshCw className="w-3 h-3" /> Обновить
              </button>
              <button
                onClick={() => window.api.openExternal('https://github.com/AUTOMATIC1111/stable-diffusion-webui')}
                className="btn-ghost text-xs flex-1"
              >
                <ExternalLink className="w-3 h-3" /> Установить
              </button>
            </div>

            <p className="text-text-muted mt-2 text-[11px]">
              Кнопка сама найдёт webui (Downloads/Desktop), включит <code>--api</code> и запустит сервер.
              Путь к папке можно задать в настройках. Для фотореализма ставь checkpoint
              <b> Juggernaut XL</b> или <b> DreamShaper XL</b> в
              <code> models/Stable-diffusion</code>.
            </p>
          </div>
        )}

        {sdStatus === 'ok' && (
          <div className="panel p-3 text-xs space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-emerald-400">
                <CheckCircle2 className="w-4 h-4" />
                AUTOMATIC1111 API работает
              </div>
              <button onClick={refreshSd} className="btn-ghost p-1" title="Обновить checkpoint'ы">
                <RefreshCw className="w-3 h-3" />
              </button>
            </div>
            <label className="block">
              <span className="text-text-muted">Checkpoint</span>
              <select
                value={currentModel}
                onChange={(e) => switchModel(e.target.value)}
                disabled={switchingModel || sdModels.length === 0}
                className="input mt-1 text-xs"
              >
                {sdModels.map((m) => (
                  <option key={m.title} value={m.title}>{m.title}</option>
                ))}
              </select>
            </label>
            <div className="text-text-muted">
              Рекомендация: <b>Juggernaut XL</b> для фотореализма/кино или <b>DreamShaper XL</b> для универсального арт-стиля.
              После установки `.safetensors` приложение само увидит модель и переключит её здесь.
            </div>
          </div>
        )}

        <div>
          <label className="text-xs text-text-muted block mb-1">Промпт</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="cinematic photo of a coffee shop, golden hour, soft light, 35mm film"
            className="input text-xs min-h-[80px] resize-y"
            disabled={sdStatus !== 'ok'}
          />
        </div>

        <div>
          <label className="text-xs text-text-muted block mb-1">Negative prompt</label>
          <textarea
            value={negative}
            onChange={(e) => setNegative(e.target.value)}
            className="input text-xs min-h-[50px] resize-y"
            disabled={sdStatus !== 'ok'}
          />
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-xs text-text-muted block mb-1">Width</label>
            <input
              type="number"
              value={width}
              onChange={(e) => setWidth(+e.target.value)}
              step={64}
              className="input text-xs"
            />
          </div>
          <div>
            <label className="text-xs text-text-muted block mb-1">Height</label>
            <input
              type="number"
              value={height}
              onChange={(e) => setHeight(+e.target.value)}
              step={64}
              className="input text-xs"
            />
          </div>
          <div>
            <label className="text-xs text-text-muted block mb-1">Steps</label>
            <input
              type="number"
              value={steps}
              onChange={(e) => setSteps(+e.target.value)}
              className="input text-xs"
            />
          </div>
        </div>

        <button
          onClick={generate}
          disabled={generating || sdStatus !== 'ok' || !prompt.trim()}
          className="btn-primary w-full"
        >
          {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          {generating ? 'Генерация...' : 'Сгенерировать'}
        </button>

        {error && (
          <div className="text-rose-400 text-xs">{error}</div>
        )}

        {/* Gallery */}
        {images.length > 0 && (
          <div className="space-y-3 pt-3 border-t border-bg-border">
            <h3 className="text-xs text-text-muted">Последние генерации</h3>
            {images.map((img) => (
              <div key={img.id} className="space-y-1">
                <img
                  src={`data:image/png;base64,${img.base64}`}
                  alt={img.prompt}
                  className="w-full rounded border border-bg-border"
                />
                <p className="text-[10px] text-text-muted truncate">{img.prompt}</p>
                <div className="flex gap-1">
                  <button
                    onClick={() => saveToProject(img)}
                    className="btn-secondary text-[11px] py-1 flex-1"
                  >
                    <Download className="w-3 h-3" /> В проект
                  </button>
                  <button
                    onClick={() => copyMarkdown(img)}
                    className="btn-ghost text-[11px] py-1"
                    title="Скопировать как markdown"
                  >
                    {copiedId === img.id ? (
                      <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
