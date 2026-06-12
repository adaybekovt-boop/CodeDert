import { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, XCircle, ExternalLink, Download, Sparkles, ArrowRight } from 'lucide-react';
import { useStore } from '../hooks/useStore';
import type { ModelRecommendation } from '../../electron/services/model-recommender';
import type { HardwareInfo } from '../../electron/services/hardware-probe';

type Step = 'welcome' | 'ollama' | 'hardware' | 'models' | 'apikey' | 'done';

export function OnboardingDialog() {
  const [step, setStep] = useState<Step>('welcome');
  const { setNeedsOnboarding } = useStore();

  async function finish() {
    await window.api.settings.set('onboardingDone', true);
    setNeedsOnboarding(false);
    // Reload to refresh model list
    window.location.reload();
  }

  return (
    <div className="fixed inset-0 z-50 bg-bg/95 backdrop-blur flex items-center justify-center animate-fade-in">
      <div className="w-full max-w-2xl panel bg-bg-panel shadow-2xl animate-slide-up">
        {step === 'welcome' && <Welcome onNext={() => setStep('ollama')} />}
        {step === 'ollama' && <OllamaCheck onNext={() => setStep('hardware')} />}
        {step === 'hardware' && <HardwareCheck onNext={() => setStep('models')} />}
        {step === 'models' && <ModelDownload onNext={() => setStep('apikey')} />}
        {step === 'apikey' && <ApiKeyStep onNext={finish} onSkip={finish} />}
      </div>
    </div>
  );
}

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="p-10 text-center">
      <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-accent/10 flex items-center justify-center">
        <Sparkles className="w-8 h-8 text-accent" strokeWidth={1.5} />
      </div>
      <h1 className="text-3xl font-display mb-2">Добро пожаловать в CodeDert</h1>
      <p className="text-text-secondary mb-8">
        Локальный AI-IDE с гибридом локальных моделей и Claude API.
        <br />
        Настроим всё за минуту.
      </p>
      <button onClick={onNext} className="btn-primary text-base px-6 py-3">
        Начать <ArrowRight className="w-4 h-4" />
      </button>
    </div>
  );
}

function OllamaCheck({ onNext }: { onNext: () => void }) {
  const [status, setStatus] = useState<'checking' | 'ok' | 'missing' | 'launching'>('checking');
  const [version, setVersion] = useState<string>('');
  const [launchError, setLaunchError] = useState<string | null>(null);

  async function probe() {
    const res = await window.api.ollama.health();
    if (res.ok) {
      setStatus('ok');
      setVersion(res.version || '');
      return true;
    }
    setStatus('missing');
    return false;
  }

  async function tryLaunch() {
    setStatus('launching');
    setLaunchError(null);
    const res = await window.api.ollama.ensureRunning();
    if (res.ok) {
      await probe();
    } else {
      setStatus('missing');
      setLaunchError(res.error || 'launch failed');
    }
  }

  useEffect(() => {
    (async () => {
      // First a fast health check — if up, done.
      const up = await probe();
      // If down, try auto-launch once (settings default is autoStart=true).
      if (!up) await tryLaunch();
    })();
  }, []);

  return (
    <div className="p-10">
      <h2 className="text-xl font-semibold mb-1">Проверка Ollama</h2>
      <p className="text-text-secondary text-sm mb-6">
        Ollama — это локальный сервер для запуска моделей. Он должен быть запущен на localhost:11434.
      </p>

      <div className="panel p-4 mb-6">
        {status === 'checking' && (
          <div className="flex items-center gap-3 text-text-secondary">
            <Loader2 className="w-5 h-5 animate-spin" />
            Подключение...
          </div>
        )}
        {status === 'launching' && (
          <div className="flex items-center gap-3 text-text-secondary">
            <Loader2 className="w-5 h-5 animate-spin" />
            Запускаю Ollama...
          </div>
        )}
        {status === 'ok' && (
          <div className="flex items-center gap-3 text-emerald-400">
            <CheckCircle2 className="w-5 h-5" />
            <div>
              <div className="font-medium">Ollama работает</div>
              {version && <div className="text-xs text-text-muted">Версия: {version}</div>}
            </div>
          </div>
        )}
        {status === 'missing' && (
          <div>
            <div className="flex items-center gap-3 text-amber-400 mb-3">
              <XCircle className="w-5 h-5" />
              <div className="font-medium">Ollama не найдена или не отвечает</div>
            </div>
            <p className="text-sm text-text-secondary mb-3">
              Без Ollama локальные модели работать не будут. Можно установить и запустить её, либо пропустить и использовать только Claude API.
            </p>
            {launchError && (
              <p className="text-xs text-rose-400 mb-3">{launchError}</p>
            )}
            <div className="flex gap-2 flex-wrap">
              <button onClick={tryLaunch} className="btn-secondary text-sm">
                <Loader2 className="w-3.5 h-3.5" />
                Запустить Ollama
              </button>
              <button
                onClick={() => window.api.openExternal('https://ollama.com/download')}
                className="btn-secondary text-sm"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Скачать Ollama
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-between">
        <button onClick={probe} className="btn-ghost">
          Проверить снова
        </button>
        <button onClick={onNext} className="btn-primary">
          Далее <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function HardwareCheck({ onNext }: { onNext: () => void }) {
  const [hw, setHw] = useState<HardwareInfo | null>(null);

  useEffect(() => {
    (async () => {
      const result = await window.api.hardware.probe();
      setHw(result);
    })();
  }, []);

  if (!hw) {
    return (
      <div className="p-10 flex items-center justify-center gap-3 text-text-secondary">
        <Loader2 className="w-5 h-5 animate-spin" />
        Анализ железа...
      </div>
    );
  }

  const tierLabels: Record<string, { label: string; emoji: string; color: string }> = {
    extreme: { label: 'Топ-класс', emoji: '🚀', color: 'text-white' },
    high: { label: 'Высокий', emoji: '⚡', color: 'text-zinc-200' },
    medium: { label: 'Средний', emoji: '✓', color: 'text-zinc-400' },
    low: { label: 'Базовый', emoji: '·', color: 'text-zinc-500' },
  };
  const tier = tierLabels[hw.tier];

  return (
    <div className="p-10">
      <h2 className="text-xl font-semibold mb-1">Ваше железо</h2>
      <p className="text-text-secondary text-sm mb-6">
        Я подобрал список моделей под вашу конфигурацию.
      </p>

      <div className="panel p-4 mb-6 space-y-2 text-sm">
        <Row label="Tier" value={
          <span className={tier.color + ' font-medium'}>
            {tier.emoji} {tier.label}
          </span>
        } />
        <Row label="CPU" value={`${hw.cpu.brand} (${hw.cpu.physicalCores}c/${hw.cpu.cores}t)`} />
        <Row label="RAM" value={`${hw.ram.totalGB} GB (${hw.ram.freeGB} GB свободно)`} />
        <Row label="GPU" value={hw.gpu ? `${hw.gpu.model} (${hw.gpu.vramGB} GB VRAM)` : 'Не обнаружено'} />
        <Row label="OS" value={`${hw.os.distro} (${hw.os.arch})`} />
      </div>

      <div className="flex justify-end">
        <button onClick={onNext} className="btn-primary">
          Подобрать модели <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between">
      <span className="text-text-muted">{label}</span>
      <span className="text-text-primary">{value}</span>
    </div>
  );
}

function ModelDownload({ onNext }: { onNext: () => void }) {
  const { setAvailableModels, setModel } = useStore();
  const [recommendations, setRecommendations] = useState<ModelRecommendation[]>([]);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [pulling, setPulling] = useState<Record<string, { status: string; percent?: number }>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; error?: string }>>({});

  useEffect(() => {
    const off = window.api.ollama.onPullProgress(({ model, status, percent }) => {
      setPulling((p) => ({ ...p, [model]: { status, percent } }));
    });
    (async () => {
      const result = await window.api.hardware.recommendModels();
      setRecommendations(result.models);
      const list = await window.api.ollama.list();
      setInstalled(new Set(list.map((m: any) => m.name)));
      setAvailableModels(list.map((m: any) => ({
        id: m.name,
        displayName: m.name,
        provider: 'ollama' as const,
      })));
    })();
    return () => {
      off();
    };
  }, []);

  async function pullModel(model: string) {
    setPulling((p) => ({ ...p, [model]: { status: 'starting download' } }));
    const res = await window.api.ollama.pull(model);
    if (res.ok) {
      setInstalled((s) => new Set([...s, model]));
      setTesting((p) => ({ ...p, [model]: true }));
      const test = await window.api.ollama.testModel(model);
      setTesting((p) => ({ ...p, [model]: false }));
      setTestResults((p) => ({ ...p, [model]: test }));
      if (test.ok) {
        setModel({ id: model, displayName: model, provider: 'ollama' });
        await window.api.settings.set('selectedModelId', model);
      }
    } else {
      setTestResults((p) => ({ ...p, [model]: { ok: false, error: res.error || 'Download failed' } }));
    }
    setPulling((p) => {
      const next = { ...p };
      delete next[model];
      return next;
    });
  }

  return (
    <div className="p-10">
      <h2 className="text-xl font-semibold mb-1">Рекомендуемые модели</h2>
      <p className="text-text-secondary text-sm mb-6">
        Можно скачать сейчас или позже из настроек. Загрузка идёт в фоне.
      </p>

      <div className="space-y-2 max-h-96 overflow-auto pr-2">
        {recommendations.slice(0, 14).map((m) => {
          const isInstalled = installed.has(m.name);
          const isPulling = pulling[m.name];
          const isTesting = testing[m.name];
          const test = testResults[m.name];
          return (
            <div key={m.name} className="panel p-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-medium text-sm truncate">{m.displayName}</span>
                  {m.recommended && (
                    <span className="chip bg-accent/10 text-accent">⭐ recommended</span>
                  )}
                  <span className="chip">{m.sizeGB} GB</span>
                </div>
                <p className="text-xs text-text-muted truncate">{m.description}</p>
                {isPulling && (
                  <div className="text-xs text-accent mt-1">
                    {isPulling.status} {isPulling.percent !== undefined && `${isPulling.percent}%`}
                  </div>
                )}
                {isTesting && (
                  <div className="text-xs text-accent mt-1">Проверяю кодовый ответ...</div>
                )}
                {test?.ok && (
                  <div className="text-xs text-emerald-400 mt-1">Модель отвечает и выбрана</div>
                )}
                {test && !test.ok && (
                  <div className="text-xs text-rose-400 mt-1">{test.error}</div>
                )}
              </div>
              <div className="shrink-0">
                {isInstalled ? (
                  <span className="text-emerald-400 text-xs flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> установлено
                  </span>
                ) : isPulling ? (
                  <Loader2 className="w-4 h-4 animate-spin text-accent" />
                ) : (
                  <button
                    onClick={() => pullModel(m.name)}
                    className="btn-secondary text-xs px-2 py-1"
                  >
                    <Download className="w-3 h-3" />
                    Скачать
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex justify-end mt-6">
        <button onClick={onNext} className="btn-primary">
          Далее <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function ApiKeyStep({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    const res = await window.api.anthropic.setKey(key);
    if (!res.ok) {
      setError(res.error || 'Не удалось сохранить');
      setSaving(false);
      return;
    }
    onNext();
  }

  return (
    <div className="p-10">
      <h2 className="text-xl font-semibold mb-1">Claude API (опционально)</h2>
      <p className="text-text-secondary text-sm mb-6">
        Подключение Claude Opus 4.7 включает команды <code className="text-accent">/cdesign</code>,{' '}
        <code className="text-accent">/plan</code> и улучшенный <code className="text-accent">/design</code>.
        Без ключа эти команды будут работать на локальной модели (качество ниже).
      </p>

      <label className="block mb-3">
        <span className="text-xs text-text-muted">Anthropic API key</span>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sk-ant-api03-..."
          className="input mt-1 font-mono text-xs"
        />
      </label>

      {error && (
        <div className="text-rose-400 text-sm mb-3">{error}</div>
      )}

      <div className="text-xs text-text-muted mb-6">
        Получить ключ:{' '}
        <button
          onClick={() => window.api.openExternal('https://console.anthropic.com/settings/keys')}
          className="text-accent underline"
        >
          console.anthropic.com/settings/keys
        </button>
        <br />
        Ключ хранится зашифрованным в Windows Credential Manager.
      </div>

      <div className="flex justify-between">
        <button onClick={onSkip} className="btn-ghost">Пропустить</button>
        <button onClick={save} disabled={!key || saving} className="btn-primary">
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          Сохранить и завершить
        </button>
      </div>
    </div>
  );
}
