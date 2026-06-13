import { useEffect, useRef, useState } from 'react';
import { MessageCircleQuestion, Send, X } from 'lucide-react';

/**
 * Renders a prompt whenever the agent's `ask` tool sends an
 * `agent:ask-request`. The user types an answer (or skips) and we call
 * `window.api.agent.respondAsk(askId, ...)`, which unblocks the agent loop.
 *
 * Multiple questions queue; only the head is shown.
 */
interface AskRequest {
  requestId: string;
  askId: string;
  question: string;
}

export function AskDialog() {
  const [queue, setQueue] = useState<AskRequest[]>([]);
  const [answer, setAnswer] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const off = window.api.agent.onAskRequest((data) => {
      setQueue((q) => [...q, data]);
    });
    return () => {
      off();
    };
  }, []);

  const current = queue[0];

  // Focus the field and clear stale text whenever a new question surfaces.
  useEffect(() => {
    if (current) {
      setAnswer('');
      // Defer so the textarea is mounted.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [current?.askId]);

  if (!current) return null;

  const settle = async (answered: boolean) => {
    await window.api.agent.respondAsk(current.askId, {
      answered,
      text: answered ? answer.trim() : undefined,
    });
    setQueue((q) => q.slice(1));
    setAnswer('');
  };

  return (
    <div className="fixed inset-0 z-[100] bg-bg/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-xl bg-bg-panel border border-bg-border rounded-lg shadow-2xl">
        <div className="px-4 py-3 border-b border-bg-border flex items-center gap-2">
          <MessageCircleQuestion className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold">AI спрашивает</h2>
          {queue.length > 1 && (
            <span className="ml-auto chip bg-bg-elevated text-text-secondary">
              +{queue.length - 1} more
            </span>
          )}
        </div>

        <div className="p-4 space-y-3">
          <div className="text-[13px] leading-relaxed text-text-primary whitespace-pre-wrap break-words">
            {current.question}
          </div>

          <textarea
            ref={inputRef}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (answer.trim()) settle(true);
              }
            }}
            placeholder="Ваш ответ..."
            className="input resize-none min-h-[80px] max-h-[240px]"
            rows={3}
          />
          <div className="text-[10px] text-text-muted">
            Ctrl/Cmd + Enter - отправить ответ. "Пропустить" - модель решит сама.
          </div>
        </div>

        <div className="px-4 py-3 border-t border-bg-border flex justify-end gap-2">
          <button
            onClick={() => settle(false)}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-bg-elevated text-text-secondary hover:text-text-primary flex items-center gap-1"
          >
            <X className="w-3 h-3" /> Пропустить
          </button>
          <button
            onClick={() => settle(true)}
            disabled={!answer.trim()}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-bg hover:bg-accent-hover disabled:opacity-40 flex items-center gap-1"
          >
            <Send className="w-3 h-3" /> Ответить
          </button>
        </div>
      </div>
    </div>
  );
}
