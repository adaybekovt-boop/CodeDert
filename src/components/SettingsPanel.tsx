import { useEffect, useState } from 'react';
import { Settings, Cpu, Download, CheckCircle2, Loader2, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { useStore } from '../hooks/useStore';
import { AppSettingsSection } from './AppSettingsSection';
import { ProvidersSection } from './ProvidersSection';

export function SettingsPanel() {
  const { setAvailableModels, setModel } = useStore();
  const [ollamaModels, setOllamaModels] = useState<any[]>([]);
  const [recommendations, setRecommendations] = useState<any[]>([]);
  const [pulling, setPulling] = useState<Record<string, { status: string; percent?: number }>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; text?: string; error?: string }>>({});

  useEffect(() => {
    refreshModels();
    (async () => {
      const r = await window.api.hardware.recommendModels();
      setRecommendations(r.models);
    })();

    const off = window.api.ollama.onPullProgress(({ model, status, percent }) => {
      setPulling((p) => ({ ...p, [model]: { status, percent } }));
    });
    return () => {
      off();
    };
  }, []);

  async function refreshModels() {
    const list = await window.api.ollama.list();
    setOllamaModels(list);
    // Preserve cloud-provider models — only replace the local ones.
    const cloud = useStore.getState().availableModels.filter((m) => m.provider !== 'ollama');
    setAvailableModels([
      ...cloud,
      ...list.map((m: any) => ({
        id: m.name,
        displayName: m.name,
        provider: 'ollama' as const,
      })),
    ]);
  }

  async function testModel(model: string) {
    setTesting((p) => ({ ...p, [model]: true }));
    const result = await window.api.ollama.testModel(model);
    setTestResults((p) => ({ ...p, [model]: result }));
    setTesting((p) => ({ ...p, [model]: false }));
    if (result.ok) {
      setModel({ id: model, displayName: model, provider: 'ollama' });
      await window.api.settings.set('selectedModelId', model);
    }
    return result;
  }

  async function pullModel(model: string) {
    setTestResults((p) => {
      const next = { ...p };
      delete next[model];
      return next;
    });
    setPulling((p) => ({ ...p, [model]: { status: 'starting download' } }));
    const pull = await window.api.ollama.pull(model);
    setPulling((p) => {
      const next = { ...p };
      delete next[model];
      return next;
    });
    await refreshModels();
    if (pull.ok) {
      await testModel(model);
    } else {
      setTestResults((p) => ({ ...p, [model]: { ok: false, error: pull.error || 'Download failed' } }));
    }
  }

  const installedNames = new Set(ollamaModels.map((m) => m.name));

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-bg-border">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-text-secondary flex items-center gap-2">
          <Settings className="w-3.5 h-3.5" />
          Настройки
        </h2>
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-5">
        {/* API providers + MCP servers */}
        <ProvidersSection />

        {/* Installed Ollama Models */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <Cpu className="w-3.5 h-3.5 text-accent" />
              Установленные модели
            </h3>
            <button onClick={refreshModels} className="btn-ghost p-1">
              <RefreshCw className="w-3 h-3" />
            </button>
          </div>
          {ollamaModels.length === 0 ? (
            <p className="text-xs text-text-muted">Нет установленных моделей</p>
          ) : (
            <div className="space-y-1">
              {ollamaModels.map((m) => (
                <div key={m.name} className="panel p-2 flex items-center justify-between text-xs">
                  <span className="font-mono">{m.name}</span>
                  <span className="text-text-muted">
                    {(m.size / 1024 / 1024 / 1024).toFixed(1)} GB
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Recommended */}
        <section>
          <h3 className="text-sm font-medium mb-2">Рекомендуемые модели</h3>
          <div className="space-y-2">
            {recommendations.slice(0, 14).map((m) => {
              const isInstalled = installedNames.has(m.name);
              const isPulling = pulling[m.name];
              const isTesting = testing[m.name];
              const test = testResults[m.name];
              return (
                <div key={m.name} className="panel p-2.5">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium">{m.displayName}</span>
                    <span className="text-[10px] text-text-muted">{m.sizeGB} GB</span>
                  </div>
                  <p className="text-[11px] text-text-muted mb-2">{m.description}</p>
                  <div className="text-[10px] text-text-muted mb-2 font-mono">
                    ollama pull {m.name}
                  </div>
                  {isInstalled ? (
                    <div className="space-y-1">
                      <div className="text-[11px] text-emerald-400 flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" /> установлено
                      </div>
                      {isTesting ? (
                        <div className="text-[11px] text-accent flex items-center gap-1">
                          <Loader2 className="w-3 h-3 animate-spin" /> проверяю кодовый ответ...
                        </div>
                      ) : test?.ok ? (
                        <div className="text-[11px] text-emerald-400 flex items-center gap-1">
                          <ShieldCheck className="w-3 h-3" /> модель отвечает и выбрана
                        </div>
                      ) : test && !test.ok ? (
                        <div className="text-[11px] text-rose-400 flex items-center gap-1">
                          <XCircle className="w-3 h-3" /> {test.error}
                        </div>
                      ) : (
                        <button onClick={() => testModel(m.name)} className="btn-secondary text-[11px] py-1">
                          <ShieldCheck className="w-3 h-3" /> Проверить и выбрать
                        </button>
                      )}
                    </div>
                  ) : isPulling ? (
                    <div className="text-[11px] text-accent flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {isPulling.status}
                      {isPulling.percent !== undefined && ` ${isPulling.percent}%`}
                    </div>
                  ) : (
                    <button
                      onClick={() => pullModel(m.name)}
                      className="btn-secondary text-[11px] py-1"
                    >
                      <Download className="w-3 h-3" /> Скачать модель
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section className="pt-4 border-t border-bg-border">
          <AppSettingsSection />
        </section>

        <section className="pt-4 border-t border-bg-border">
          <button
            onClick={async () => {
              await window.api.settings.set('onboardingDone', false);
              window.location.reload();
            }}
            className="btn-ghost text-xs w-full"
          >
            Запустить onboarding заново
          </button>
        </section>
      </div>
    </div>
  );
}
