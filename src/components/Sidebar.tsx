import { Files, MessageSquare, ImageIcon, Settings, Sparkles, Brain } from 'lucide-react';
import { useStore } from '../hooks/useStore';
import { cn } from '../lib/utils';

const ITEMS = [
  { id: 'files', icon: Files, label: 'Файлы' },
  { id: 'brain', icon: Brain, label: 'Brain' },
  { id: 'image', icon: ImageIcon, label: 'Картинки' },
  { id: 'settings', icon: Settings, label: 'Настройки' },
] as const;

export function Sidebar() {
  const { activePanel, setActivePanel } = useStore();

  return (
    <div className="w-14 bg-bg-panel border-r border-bg-border flex flex-col items-center py-3 gap-1">
      <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center mb-2">
        <Sparkles className="w-5 h-5 text-accent" strokeWidth={1.5} />
      </div>
      {ITEMS.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          onClick={() => setActivePanel(id as any)}
          title={label}
          className={cn(
            'w-10 h-10 rounded-lg flex items-center justify-center transition-colors group relative',
            activePanel === id
              ? 'bg-accent/15 text-accent'
              : 'text-text-secondary hover:text-text-primary hover:bg-bg-elevated'
          )}
        >
          <Icon className="w-5 h-5" strokeWidth={1.5} />
          {activePanel === id && (
            <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-accent rounded-r" />
          )}
        </button>
      ))}
    </div>
  );
}
