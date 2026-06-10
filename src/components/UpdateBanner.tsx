import { useEffect, useState } from 'react';
import { Download, RefreshCw, X, Loader2 } from 'lucide-react';

interface UpdaterEvent {
  status: string;
  version?: string;
  notes?: string;
  percent?: number;
  error?: string;
  currentVersion: string;
}

/**
 * Slim top banner: appears only when a new GitHub release is available.
 * available → [Обновить] → downloading (progress) → downloaded → [Перезапустить].
 */
export function UpdateBanner() {
  const [ev, setEv] = useState<UpdaterEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Pick up state that may have arrived before mount, then subscribe.
    window.api.updater.state().then((s) => {
      if (s && (s.status === 'available' || s.status === 'downloading' || s.status === 'downloaded')) {
        setEv(s as UpdaterEvent);
      }
    }).catch(() => {});
    const off = window.api.updater.onEvent((data) => {
      if (['available', 'downloading', 'downloaded', 'error'].includes(data.status)) {
        setEv(data);
      }
    });
    return off;
  }, []);

  if (!ev || dismissed) return null;
  // Errors are only shown if they happened mid-download (user already engaged).
  if (ev.status === 'error' && ev.percent === undefined) return null;

  return (
    <div className="h-9 shrink-0 flex items-center gap-3 px-3 text-xs border-b border-bg-border bg-accent/10">
      {ev.status === 'available' && (
        <>
          <span className="text-text-primary">
            Доступно обновление <b>v{ev.version}</b>{' '}
            <span className="text-text-muted">(сейчас v{ev.currentVersion})</span>
          </span>
          <button
            onClick={() => window.api.updater.download()}
            className="btn-primary text-xs py-0.5 px-2 flex items-center gap-1"
          >
            <Download className="w-3 h-3" /> Обновить
          </button>
        </>
      )}
      {ev.status === 'downloading' && (
        <span className="flex items-center gap-2 text-text-primary">
          <Loader2 className="w-3 h-3 animate-spin" />
          Загрузка обновления v{ev.version}… {ev.percent ?? 0}%
        </span>
      )}
      {ev.status === 'downloaded' && (
        <>
          <span className="text-emerald-400">Обновление v{ev.version} готово к установке.</span>
          <button
            onClick={() => window.api.updater.install()}
            className="btn-primary text-xs py-0.5 px-2 flex items-center gap-1"
          >
            <RefreshCw className="w-3 h-3" /> Перезапустить и установить
          </button>
        </>
      )}
      {ev.status === 'error' && (
        <span className="text-rose-400 truncate">Ошибка обновления: {ev.error}</span>
      )}
      <div className="flex-1" />
      <button onClick={() => setDismissed(true)} className="btn-ghost p-1" title="Скрыть">
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}
