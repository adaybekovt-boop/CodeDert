import { useMemo, useState } from 'react';
import { ChevronDown, Palette, Film, Cpu, Sparkles, Search } from 'lucide-react';
import { useStore } from '../hooks/useStore';
import { cn } from '../lib/utils';
import { PROVIDER_LABELS } from '../types';
import type { ChatMode, ModelChoice } from '../types';

export function ModelSelectorBar() {
  const { selectedModel, availableModels, setModel, chatMode, setChatMode, workspaceRoot } = useStore();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');

  const modeButtons: { id: ChatMode; label: string; icon: any; tooltip: string }[] = [
    { id: 'code', label: 'Код', icon: Cpu, tooltip: 'Обычный режим программиста' },
    { id: 'design', label: '/design', icon: Palette, tooltip: 'Режим дизайн-критика (UX/UI review)' },
    { id: 'cdesign', label: '/cdesign', icon: Film, tooltip: 'Cinematic landing generator' },
  ];

  // Group by provider, apply text filter.
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? availableModels.filter(
          (m) => m.id.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q)
        )
      : availableModels;
    const map = new Map<string, ModelChoice[]>();
    for (const m of filtered) {
      const key = m.provider;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(m);
    }
    // Local first, then providers alphabetically.
    return [...map.entries()].sort(([a], [b]) => {
      if (a === 'ollama') return -1;
      if (b === 'ollama') return 1;
      return a.localeCompare(b);
    });
  }, [availableModels, filter]);

  return (
    <div className="h-11 border-b border-bg-border bg-bg-panel flex items-center px-3 gap-2">
      {/* Workspace */}
      <div className="flex-1 text-xs text-text-secondary truncate">
        {workspaceRoot ? (
          <>
            <span className="text-text-muted">📁 </span>
            {workspaceRoot}
          </>
        ) : (
          <span className="text-text-muted">Папка не открыта</span>
        )}
      </div>

      {/* Mode toggle group */}
      <div className="flex rounded-md bg-bg border border-bg-border p-0.5 gap-0.5">
        {modeButtons.map(({ id, label, icon: Icon, tooltip }) => (
          <button
            key={id}
            onClick={() => setChatMode(id)}
            title={tooltip}
            className={cn(
              'px-2 py-1 text-xs rounded flex items-center gap-1 transition-colors',
              chatMode === id
                ? 'bg-accent text-bg font-medium'
                : 'text-text-secondary hover:text-text-primary hover:bg-bg-elevated'
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* Model picker */}
      <div className="relative">
        <button
          onClick={() => {
            setOpen(!open);
            setFilter('');
          }}
          className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-bg border border-bg-border hover:bg-bg-elevated text-sm"
        >
          <Sparkles className="w-3.5 h-3.5 text-accent" />
          <span className="truncate max-w-[200px]">
            {selectedModel?.displayName || 'Выберите модель'}
          </span>
          {selectedModel && (
            <span className="text-[10px] text-text-muted">
              {PROVIDER_LABELS[selectedModel.provider] || selectedModel.provider}
            </span>
          )}
          <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <div className="absolute right-0 top-full mt-1 w-80 bg-bg-panel border border-bg-border rounded-md shadow-xl z-20 py-1 max-h-[28rem] overflow-auto">
              {availableModels.length > 10 && (
                <div className="px-2 pb-1 sticky top-0 bg-bg-panel">
                  <div className="flex items-center gap-1.5 bg-bg border border-bg-border rounded px-2 py-1">
                    <Search className="w-3 h-3 text-text-muted shrink-0" />
                    <input
                      autoFocus
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="Поиск модели…"
                      className="bg-transparent outline-none text-xs w-full"
                    />
                  </div>
                </div>
              )}
              {availableModels.length === 0 ? (
                <div className="px-3 py-2 text-sm text-text-muted">
                  Нет доступных моделей. Запустите Ollama или добавьте API-ключ провайдера в настройках.
                </div>
              ) : groups.length === 0 ? (
                <div className="px-3 py-2 text-sm text-text-muted">Ничего не найдено</div>
              ) : (
                groups.map(([provider, models]) => (
                  <div key={provider}>
                    <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-text-muted font-semibold">
                      {PROVIDER_LABELS[provider] || provider}
                      <span className="ml-1 opacity-60">({models.length})</span>
                    </div>
                    {models.map((m) => (
                      <button
                        key={`${m.provider}:${m.id}`}
                        onClick={() => {
                          setModel(m);
                          setOpen(false);
                        }}
                        className={cn(
                          'w-full text-left px-3 py-1.5 text-sm flex items-center justify-between hover:bg-bg-elevated',
                          selectedModel?.id === m.id &&
                            selectedModel?.provider === m.provider &&
                            'bg-accent/10 text-accent'
                        )}
                      >
                        <span className="truncate" title={m.id}>
                          {m.displayName}
                        </span>
                      </button>
                    ))}
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
