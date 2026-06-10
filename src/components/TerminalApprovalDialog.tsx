import { useEffect, useState } from 'react';
import { AlertTriangle, Terminal, Check, X } from 'lucide-react';

/**
 * Renders an approval prompt whenever the main process sends a
 * `terminal:approval-request`. The user clicks Allow or Deny and we call
 * `window.api.terminal.respond(requestId, ...)`.
 *
 * Multiple requests are queued — only the head of the queue is shown.
 */
interface Request {
  requestId: string;
  command: string;
  cwd: string;
  timeoutMs: number;
}

export function TerminalApprovalDialog() {
  const [queue, setQueue] = useState<Request[]>([]);

  useEffect(() => {
    const off = window.api.terminal.onApprovalRequest((data) => {
      setQueue((q) => [...q, data]);
    });
    return () => {
      off();
    };
  }, []);

  if (queue.length === 0) return null;
  const current = queue[0];

  const settle = async (approved: boolean) => {
    await window.api.terminal.respond(current.requestId, { approved });
    setQueue((q) => q.slice(1));
  };

  return (
    <div className="fixed inset-0 z-[100] bg-bg/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-xl bg-bg-panel border border-bg-border rounded-lg shadow-2xl">
        <div className="px-4 py-3 border-b border-bg-border flex items-center gap-2">
          <Terminal className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold">Agent wants to run a command</h2>
          {queue.length > 1 && (
            <span className="ml-auto chip bg-bg-elevated text-text-secondary">
              +{queue.length - 1} more
            </span>
          )}
        </div>

        <div className="p-4 space-y-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-text-muted mb-1">Command</div>
            <pre className="bg-bg rounded-md p-3 text-xs font-mono whitespace-pre-wrap break-words border border-bg-border max-h-48 overflow-auto">
              {current.command}
            </pre>
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-text-muted">Working dir</div>
              <div className="font-mono text-text-secondary truncate" title={current.cwd}>
                {current.cwd}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-text-muted">Timeout</div>
              <div className="font-mono text-text-secondary">{Math.round(current.timeoutMs / 1000)}s</div>
            </div>
          </div>

          <div className="flex items-start gap-2 text-[11px] text-amber-400 bg-amber-500/10 rounded-md p-2 border border-amber-500/20">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <div>
              Commands run with your user's privileges inside the workspace.
              Review carefully before allowing. Disable approval prompts in
              Settings → Agent if you trust the running task.
            </div>
          </div>
        </div>

        <div className="px-4 py-3 border-t border-bg-border flex justify-end gap-2">
          <button
            onClick={() => settle(false)}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-bg-elevated text-text-secondary hover:text-text-primary flex items-center gap-1"
          >
            <X className="w-3 h-3" /> Deny
          </button>
          <button
            onClick={() => settle(true)}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-bg hover:bg-accent-hover flex items-center gap-1"
          >
            <Check className="w-3 h-3" /> Allow once
          </button>
        </div>
      </div>
    </div>
  );
}
