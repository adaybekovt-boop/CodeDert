import { useEffect, useState } from 'react';
import {
  Key,
  CheckCircle2,
  Loader2,
  Trash2,
  RefreshCw,
  ExternalLink,
  XCircle,
  Plug,
  Plus,
} from 'lucide-react';
import { useStore } from '../hooks/useStore';

interface ProviderStatus {
  id: string;
  label: string;
  kind: 'openai' | 'anthropic';
  keyHint: string;
  keysUrl: string;
  baseUrl: string;
  hasKey: boolean;
  modelCount: number;
}

interface McpStatus {
  name: string;
  command: string;
  enabled: boolean;
  state: string;
  error?: string;
  toolCount: number;
}

/** Merge fresh cloud models into the global model list (keeps ollama entries). */
async function syncModelsIntoStore() {
  const { availableModels, setAvailableModels } = useStore.getState();
  const cloud = await window.api.providers.allModels();
  const local = availableModels.filter((m) => m.provider === 'ollama');
  setAvailableModels([
    ...cloud.map((m: any) => ({ id: m.id, displayName: m.displayName || m.id, provider: m.provider })),
    ...local,
  ]);
}

export function ProvidersSection() {
  const { setHasAnthropicKey } = useStore();
  const [list, setList] = useState<ProviderStatus[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [baseUrlInput, setBaseUrlInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, { ok: boolean; text: string }>>({});

  async function refresh() {
    const s = await window.api.providers.status();
    setList(s);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function saveKey(p: ProviderStatus) {
    if (!keyInput.trim()) return;
    setBusy(p.id);
    setMsg((m) => ({ ...m, [p.id]: { ok: true, text: 'Проверяю ключ (GET /models — без трат токенов)…' } }));
    if (baseUrlInput.trim() !== p.baseUrl) {
      const r = await window.api.providers.setBaseUrl(p.id, baseUrlInput.trim());
      if (!r.ok) {
        setMsg((m) => ({ ...m, [p.id]: { ok: false, text: r.error || 'некорректный URL' } }));
        setBusy(null);
        return;
      }
    }
    const res = await window.api.providers.setKey(p.id, keyInput.trim());
    setBusy(null);
    if (res.ok) {
      setMsg((m) => ({
        ...m,
        [p.id]: { ok: true, text: `Ключ работает ✓ Моделей: ${res.models?.length ?? 0}` },
      }));
      setKeyInput('');
      setOpenId(null);
      if (p.id === 'anthropic') setHasAnthropicKey(true);
      await refresh();
      await syncModelsIntoStore();
    } else {
      setMsg((m) => ({ ...m, [p.id]: { ok: false, text: res.error || 'ключ отклонён' } }));
    }
  }

  async function clearKey(p: ProviderStatus) {
    await window.api.providers.clearKey(p.id);
    if (p.id === 'anthropic') setHasAnthropicKey(false);
    setMsg((m) => ({ ...m, [p.id]: { ok: true, text: 'Ключ удалён' } }));
    await refresh();
    await syncModelsIntoStore();
  }

  async function refreshModels(p: ProviderStatus) {
    setBusy(p.id);
    const res = await window.api.providers.refreshModels(p.id);
    setBusy(null);
    setMsg((m) => ({
      ...m,
      [p.id]: res.ok
        ? { ok: true, text: `Обновлено: ${res.models?.length ?? 0} моделей` }
        : { ok: false, text: res.error || 'ошибка' },
    }));
    if (res.ok) {
      await refresh();
      await syncModelsIntoStore();
    }
  }

  return (
    <section>
      <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
        <Key className="w-3.5 h-3.5 text-accent" />
        API-провайдеры
      </h3>
      <p className="text-[11px] text-text-muted mb-2">
        Проверка ключа — один GET /models: токены не тратятся, модели появляются в списке выбора.
      </p>
      <div className="space-y-1.5">
        {list.map((p) => {
          const m = msg[p.id];
          const isOpen = openId === p.id;
          return (
            <div key={p.id} className="panel p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-medium truncate">{p.label}</div>
                  <div className="text-[10px] text-text-muted">
                    {p.hasKey ? (
                      <span className="text-emerald-400 inline-flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" /> ключ задан · {p.modelCount} моделей
                      </span>
                    ) : (
                      <span>ключ не задан</span>
                    )}
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  {p.hasKey && (
                    <button
                      title="Обновить список моделей"
                      onClick={() => refreshModels(p)}
                      className="btn-ghost p-1"
                      disabled={busy === p.id}
                    >
                      {busy === p.id ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <RefreshCw className="w-3 h-3" />
                      )}
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setOpenId(isOpen ? null : p.id);
                      setKeyInput('');
                      setBaseUrlInput(p.baseUrl);
                    }}
                    className="btn-ghost text-[11px]"
                  >
                    {p.hasKey ? 'Заменить' : 'Добавить ключ'}
                  </button>
                  {p.hasKey && (
                    <button onClick={() => clearKey(p)} className="btn-ghost p-1 text-rose-400" title="Удалить ключ">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>

              {isOpen && (
                <div className="mt-2 space-y-1.5">
                  <input
                    type="password"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    placeholder={p.keyHint}
                    className="input font-mono text-xs"
                  />
                  {(p.id === 'custom' || p.id === 'qwen' || p.id === 'moonshot') && (
                    <input
                      type="text"
                      value={baseUrlInput}
                      onChange={(e) => setBaseUrlInput(e.target.value)}
                      placeholder="Base URL (OpenAI-compatible), напр. https://host/v1"
                      className="input font-mono text-xs"
                    />
                  )}
                  <div className="flex gap-2 items-center">
                    <button
                      onClick={() => saveKey(p)}
                      disabled={!keyInput.trim() || busy === p.id}
                      className="btn-primary text-xs"
                    >
                      {busy === p.id && <Loader2 className="w-3 h-3 animate-spin" />}
                      Сохранить и проверить
                    </button>
                    {p.keysUrl && (
                      <button
                        onClick={() => window.api.openExternal(p.keysUrl)}
                        className="text-[11px] text-accent hover:underline flex items-center gap-1"
                      >
                        <ExternalLink className="w-3 h-3" /> получить ключ
                      </button>
                    )}
                  </div>
                </div>
              )}

              {m && (
                <p className={`mt-1 text-[11px] ${m.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {m.text}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <McpServersBlock />
    </section>
  );
}

function McpServersBlock() {
  const [servers, setServers] = useState<{ name: string; command: string; args: string[]; enabled: boolean }[]>([]);
  const [status, setStatus] = useState<McpStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState({ name: '', command: '' });

  async function load() {
    const s = await window.api.appSettings.get();
    setServers(s?.mcp?.servers || []);
    setStatus(await window.api.mcp.status());
  }

  useEffect(() => {
    load();
  }, []);

  async function persist(next: { name: string; command: string; args: string[]; enabled: boolean }[]) {
    setServers(next);
    await window.api.appSettings.patch({ mcp: { servers: next } } as any);
    setStatus(await window.api.mcp.status());
  }

  async function addServer() {
    const name = draft.name.trim();
    const cmdLine = draft.command.trim();
    if (!name || !cmdLine) return;
    // First token = command, rest = args.
    const parts = cmdLine.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const command = (parts[0] || '').replace(/^"|"$/g, '');
    const args = parts.slice(1).map((a) => a.replace(/^"|"$/g, ''));
    await persist([...servers.filter((s) => s.name !== name), { name, command, args, enabled: false }]);
    setDraft({ name: '', command: '' });
  }

  async function syncNow() {
    setLoading(true);
    try {
      setStatus(await window.api.mcp.sync());
    } finally {
      setLoading(false);
    }
  }

  const stateOf = (name: string) => status.find((s) => s.name === name);

  return (
    <div className="mt-4">
      <h3 className="text-sm font-medium mb-1 flex items-center gap-2">
        <Plug className="w-3.5 h-3.5 text-accent" />
        MCP-серверы
      </h3>
      <p className="text-[11px] text-text-muted mb-2">
        Внешние инструменты для ИИ (Model Context Protocol, stdio). Пример: имя{' '}
        <span className="font-mono">filesystem</span>, команда{' '}
        <span className="font-mono">npx -y @modelcontextprotocol/server-filesystem C:\proj</span>.
        Сервер запускается только после явного включения.
      </p>

      <div className="space-y-1.5">
        {servers.map((s) => {
          const st = stateOf(s.name);
          return (
            <div key={s.name} className="panel p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-medium truncate">{s.name}</div>
                  <div className="text-[10px] text-text-muted font-mono truncate" title={[s.command, ...s.args].join(' ')}>
                    {[s.command, ...s.args].join(' ')}
                  </div>
                  {st && st.state === 'running' && (
                    <div className="text-[10px] text-emerald-400 inline-flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> работает · {st.toolCount} инструментов
                    </div>
                  )}
                  {st && st.state === 'error' && (
                    <div className="text-[10px] text-rose-400 inline-flex items-center gap-1" title={st.error}>
                      <XCircle className="w-3 h-3" /> ошибка: {st.error?.slice(0, 80)}
                    </div>
                  )}
                </div>
                <div className="flex gap-1 items-center shrink-0">
                  <label className="text-[10px] text-text-muted flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      onChange={(e) =>
                        persist(servers.map((x) => (x.name === s.name ? { ...x, enabled: e.target.checked } : x)))
                      }
                    />
                    вкл
                  </label>
                  <button
                    onClick={() => persist(servers.filter((x) => x.name !== s.name))}
                    className="btn-ghost p-1 text-rose-400"
                    title="Удалить"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-2 space-y-1.5">
        <input
          type="text"
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          placeholder="Имя (например, filesystem)"
          className="input text-xs"
        />
        <input
          type="text"
          value={draft.command}
          onChange={(e) => setDraft((d) => ({ ...d, command: e.target.value }))}
          placeholder="Команда запуска (npx -y @modelcontextprotocol/server-...)"
          className="input font-mono text-xs"
        />
        <div className="flex gap-2">
          <button onClick={addServer} disabled={!draft.name.trim() || !draft.command.trim()} className="btn-secondary text-xs">
            <Plus className="w-3 h-3" /> Добавить
          </button>
          <button onClick={syncNow} disabled={loading} className="btn-ghost text-xs">
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            Перезапустить серверы
          </button>
        </div>
      </div>
    </div>
  );
}
