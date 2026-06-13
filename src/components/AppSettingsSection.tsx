import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';

type AppSettings = any; // Mirrors the main-side AppSettings; kept loose to avoid duplicate types.

interface NumberFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  hint?: string;
}

function NumberField({ label, value, min, max, step = 1, onChange, hint }: NumberFieldProps) {
  return (
    <label className="block">
      <span className="text-xs text-text-secondary">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="input mt-1 font-mono text-xs"
      />
      {hint && <span className="text-[10px] text-text-muted">{hint}</span>}
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  hint,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs text-text-secondary">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="input mt-1 font-mono text-xs"
      />
      {hint && <span className="text-[10px] text-text-muted">{hint}</span>}
    </label>
  );
}

function BoolField({
  label,
  value,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <div className="flex-1">
        <div className="text-xs">{label}</div>
        {hint && <div className="text-[10px] text-text-muted">{hint}</div>}
      </div>
    </label>
  );
}

function Section({
  title,
  children,
  initialOpen,
}: {
  title: string;
  children: React.ReactNode;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!initialOpen);
  return (
    <div className="border border-bg-border rounded-md">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-elevated"
      >
        <span>{title}</span>
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
      </button>
      {open && <div className="p-3 space-y-3 border-t border-bg-border">{children}</div>}
    </div>
  );
}

function OllamaStartButton() {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setStatus('launching…');
          const res = await window.api.ollama.ensureRunning();
          setBusy(false);
          if (res.ok && res.alreadyRunning) setStatus('Ollama already running ✓');
          else if (res.ok && res.spawned) setStatus(`Started Ollama in ${res.waitedMs}ms ✓`);
          else if (res.ok) setStatus('Ollama is healthy ✓');
          else setStatus(`Failed: ${res.error || 'unknown'}`);
        }}
        className="btn-secondary text-xs"
      >
        {busy ? 'Launching…' : 'Start Ollama now'}
      </button>
      {status && <div className="text-[10px] text-text-muted mt-1">{status}</div>}
    </div>
  );
}

export function AppSettingsSection() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState<'idle' | 'saving' | 'ok'>('idle');

  useEffect(() => {
    window.api.appSettings.get().then(setSettings);
  }, []);

  if (!settings) {
    return <div className="text-xs text-text-muted">Loading settings…</div>;
  }

  const update = async (patch: Partial<AppSettings>) => {
    setSaved('saving');
    const next = await window.api.appSettings.patch(patch);
    setSettings(next);
    setSaved('ok');
    setTimeout(() => setSaved('idle'), 800);
  };

  const arrToText = (a: string[]) => (a || []).join(', ');
  const textToArr = (s: string) =>
    s
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Advanced settings</h3>
        <div className="flex items-center gap-2">
          {saved !== 'idle' && (
            <span className="text-[10px] text-text-muted">
              {saved === 'saving' ? 'saving…' : 'saved'}
            </span>
          )}
          <button
            onClick={async () => {
              const next = await window.api.appSettings.reset();
              setSettings(next);
            }}
            title="Reset to defaults"
            className="text-text-muted hover:text-text-primary p-1"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <Section title="Provider" initialOpen>
        <TextField
          label="Ollama base URL"
          value={settings.provider.ollama.baseUrl}
          onChange={(v) =>
            update({
              provider: { ollama: { ...settings.provider.ollama, baseUrl: v } },
            } as any)
          }
          placeholder="http://localhost:11434"
        />
        <BoolField
          label="Auto-start Ollama when the app opens"
          value={settings.provider.ollama.autoStart ?? true}
          onChange={(v) =>
            update({
              provider: { ollama: { ...settings.provider.ollama, autoStart: v } },
            } as any)
          }
          hint="If Ollama isn't running, the app tries to launch it (Windows install path, macOS Ollama.app, or `ollama serve` on PATH)."
        />
        <OllamaStartButton />
      </Section>

      <Section title="Default models">
        <TextField
          label="Chat (default)"
          value={settings.models.chat}
          onChange={(v) => update({ models: { ...settings.models, chat: v } } as any)}
          hint="If empty, the picker's selection is used."
        />
        <TextField
          label="Coder (executor)"
          value={settings.models.coder}
          onChange={(v) => update({ models: { ...settings.models, coder: v } } as any)}
        />
        <TextField
          label="Planner"
          value={settings.models.planner}
          onChange={(v) => update({ models: { ...settings.models, planner: v } } as any)}
        />
        <TextField
          label="Critic"
          value={settings.models.critic}
          onChange={(v) => update({ models: { ...settings.models, critic: v } } as any)}
        />
        <TextField
          label="Reviewer"
          value={settings.models.reviewer}
          onChange={(v) => update({ models: { ...settings.models, reviewer: v } } as any)}
        />
      </Section>

      <Section title="Model tuning">
        <NumberField
          label="Temperature"
          value={settings.tuning.temperature}
          min={0}
          max={2}
          step={0.05}
          onChange={(v) => update({ tuning: { ...settings.tuning, temperature: v } } as any)}
        />
        <NumberField
          label="Max output tokens"
          value={settings.tuning.maxOutputTokens}
          min={64}
          max={32768}
          onChange={(v) => update({ tuning: { ...settings.tuning, maxOutputTokens: v } } as any)}
        />
        <NumberField
          label="Context window (num_ctx)"
          value={settings.tuning.contextWindow}
          min={1024}
          max={200000}
          onChange={(v) => update({ tuning: { ...settings.tuning, contextWindow: v } } as any)}
        />
        <NumberField
          label="keep_alive (seconds, 0 = unload immediately)"
          value={settings.tuning.keepAliveSeconds}
          min={0}
          max={3600}
          onChange={(v) =>
            update({ tuning: { ...settings.tuning, keepAliveSeconds: v } } as any)
          }
        />
      </Section>

      <Section title="Agent safety">
        <BoolField
          label="Require approval before edits"
          value={settings.agent.requireApprovalForEdits}
          onChange={(v) =>
            update({ agent: { ...settings.agent, requireApprovalForEdits: v } } as any)
          }
        />
        <NumberField
          label="Max tool calls per task"
          value={settings.agent.maxToolCalls}
          min={1}
          max={50}
          onChange={(v) => update({ agent: { ...settings.agent, maxToolCalls: v } } as any)}
        />
        <NumberField
          label="Max files per task"
          value={settings.agent.maxFilesPerTask}
          min={1}
          max={200}
          onChange={(v) =>
            update({ agent: { ...settings.agent, maxFilesPerTask: v } } as any)
          }
        />
        <NumberField
          label="Max edit bytes"
          value={settings.agent.maxEditBytes}
          min={1024}
          max={5_000_000}
          onChange={(v) => update({ agent: { ...settings.agent, maxEditBytes: v } } as any)}
        />
        <BoolField
          label="Allow agent to edit .env and secret files"
          value={settings.agent.allowEnvEdits}
          onChange={(v) =>
            update({ agent: { ...settings.agent, allowEnvEdits: v } } as any)
          }
          hint="Off by default. Re-enables only the read; protectedGlobs still apply to listings."
        />
        <TextField
          label="Protected globs (comma-separated)"
          value={arrToText(settings.agent.protectedGlobs)}
          onChange={(v) =>
            update({ agent: { ...settings.agent, protectedGlobs: textToArr(v) } } as any)
          }
        />
        <div className="border-t border-bg-border pt-3 space-y-3">
          <div className="text-[11px] uppercase tracking-wider text-text-muted">Terminal commands</div>
          <BoolField
            label="Allow terminal commands"
            value={settings.agent.allowTerminal ?? false}
            onChange={(v) => update({ agent: { ...settings.agent, allowTerminal: v } } as any)}
            hint="Master switch for the run_command tool. Off = the agent cannot run shell commands at all."
          />
          <BoolField
            label="Require approval for every command"
            value={settings.agent.requireApprovalForCommands ?? true}
            onChange={(v) =>
              update({ agent: { ...settings.agent, requireApprovalForCommands: v } } as any)
            }
            hint="A dialog appears for each command. Strongly recommended."
          />
          <NumberField
            label="Command timeout (ms)"
            value={settings.agent.terminalTimeoutMs ?? 60000}
            min={1000}
            max={30 * 60 * 1000}
            step={1000}
            onChange={(v) =>
              update({ agent: { ...settings.agent, terminalTimeoutMs: v } } as any)
            }
          />
          <NumberField
            label="Max output bytes per command"
            value={settings.agent.terminalMaxOutputBytes ?? 200000}
            min={1024}
            max={5_000_000}
            step={1024}
            onChange={(v) =>
              update({ agent: { ...settings.agent, terminalMaxOutputBytes: v } } as any)
            }
          />
          <TextField
            label="Auto-verify command (after edits)"
            value={settings.agent.verifyCommand ?? ''}
            onChange={(v) => update({ agent: { ...settings.agent, verifyCommand: v } } as any)}
            placeholder="npm run typecheck"
            hint="Runs after a task that changed files. On failure the agent gets the output and tries to fix what it broke. Empty = off. Needs 'Allow terminal commands'."
          />
          <div className="text-[10px] text-text-muted">
            A hard denylist always blocks <code>rm -rf /</code>, <code>format c:</code>,
            <code> mkfs</code>, <code>dd if=… of=/dev/…</code>, shutdown/reboot, fork-bombs,
            and curl-pipe-shell — regardless of the toggle above.
          </div>
        </div>
      </Section>

      <Section title="Workspace">
        <TextField
          label="Ignored folders (comma-separated)"
          value={arrToText(settings.workspace.ignoredFolders)}
          onChange={(v) =>
            update({ workspace: { ...settings.workspace, ignoredFolders: textToArr(v) } } as any)
          }
        />
        <NumberField
          label="Max file bytes (read)"
          value={settings.workspace.maxFileBytes}
          min={1024}
          max={100 * 1024 * 1024}
          onChange={(v) =>
            update({ workspace: { ...settings.workspace, maxFileBytes: v } } as any)
          }
        />
        <BoolField
          label="Include test files in context"
          value={settings.workspace.includeTests}
          onChange={(v) =>
            update({ workspace: { ...settings.workspace, includeTests: v } } as any)
          }
        />
        <BoolField
          label="Include config files in context"
          value={settings.workspace.includeConfigs}
          onChange={(v) =>
            update({ workspace: { ...settings.workspace, includeConfigs: v } } as any)
          }
        />
        <BoolField
          label="Include hidden files"
          value={settings.workspace.includeHidden}
          onChange={(v) =>
            update({ workspace: { ...settings.workspace, includeHidden: v } } as any)
          }
        />
      </Section>

      <Section title="Performance">
        <NumberField
          label="Stream throttle (ms)"
          value={settings.performance.streamThrottleMs}
          min={0}
          max={1000}
          onChange={(v) =>
            update({ performance: { ...settings.performance, streamThrottleMs: v } } as any)
          }
        />
        <NumberField
          label="Max chat history"
          value={settings.performance.maxChatHistory}
          min={10}
          max={5000}
          onChange={(v) =>
            update({ performance: { ...settings.performance, maxChatHistory: v } } as any)
          }
        />
        <NumberField
          label="Max rendered messages"
          value={settings.performance.maxRenderedMessages}
          min={10}
          max={1000}
          onChange={(v) =>
            update({ performance: { ...settings.performance, maxRenderedMessages: v } } as any)
          }
        />
        <NumberField
          label="Max context bytes"
          value={settings.performance.maxContextBytes}
          min={4_000}
          max={1_000_000}
          onChange={(v) =>
            update({ performance: { ...settings.performance, maxContextBytes: v } } as any)
          }
        />
        <NumberField
          label="Scan concurrency"
          value={settings.performance.scanConcurrency}
          min={1}
          max={32}
          onChange={(v) =>
            update({ performance: { ...settings.performance, scanConcurrency: v } } as any)
          }
        />
      </Section>

      <Section title="Brain (knowledge graph)">
        <BoolField
          label="Enable Brain"
          value={settings.brain?.enabled ?? true}
          onChange={(v) => update({ brain: { ...settings.brain, enabled: v } } as any)}
        />
        <BoolField
          label="Auto-capture from chats"
          value={settings.brain?.autoCapture ?? true}
          onChange={(v) => update({ brain: { ...settings.brain, autoCapture: v } } as any)}
          hint="Scans each chat response for ideas/decisions/TODOs and proposes them for review."
        />
        <BoolField
          label="Require review before saving"
          value={settings.brain?.requireReview ?? true}
          onChange={(v) => update({ brain: { ...settings.brain, requireReview: v } } as any)}
        />
        <BoolField
          label="Inject relevant Brain notes into chat context"
          value={settings.brain?.injectRelevantNotes ?? true}
          onChange={(v) =>
            update({ brain: { ...settings.brain, injectRelevantNotes: v } } as any)
          }
        />
        <NumberField
          label="Min confidence (0..1)"
          value={settings.brain?.minConfidence ?? 0.6}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => update({ brain: { ...settings.brain, minConfidence: v } } as any)}
        />
        <NumberField
          label="Max suggestions per conversation"
          value={settings.brain?.maxSuggestionsPerConversation ?? 5}
          min={0}
          max={50}
          onChange={(v) =>
            update({ brain: { ...settings.brain, maxSuggestionsPerConversation: v } } as any)
          }
        />
        <NumberField
          label="Max injected nodes per prompt"
          value={settings.brain?.maxInjectedNodes ?? 5}
          min={0}
          max={50}
          onChange={(v) => update({ brain: { ...settings.brain, maxInjectedNodes: v } } as any)}
        />
        <NumberField
          label="Dedup similarity threshold (0..1)"
          value={settings.brain?.dedupSimilarityThreshold ?? 0.7}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) =>
            update({ brain: { ...settings.brain, dedupSimilarityThreshold: v } } as any)
          }
        />
        <TextField
          label="Protected tags (comma-separated)"
          value={(settings.brain?.protectedTags || []).join(', ')}
          onChange={(v) =>
            update({
              brain: { ...settings.brain, protectedTags: textToArr(v) },
            } as any)
          }
          hint="Notes tagged with these stay out of auto-capture and retrieval."
        />
        <div className="text-[10px] text-text-muted">
          Auto-capture rejects content that looks like credentials, tokens, .env values, or
          high-entropy blobs — regardless of these toggles.
        </div>
      </Section>

      <Section title="Safety invariants (read-only)">
        <BoolField
          label="Sequential local models (always on)"
          value={settings.sequentialLocalModels}
          onChange={() => {}}
          disabled
          hint="Hard invariant. Two large local models never run at once."
        />
        <BoolField
          label="Destructive terminal allowed"
          value={settings.allowDestructiveTerminal}
          onChange={() => {}}
          disabled
          hint="Hard invariant. No terminal execution is wired up."
        />
      </Section>
    </div>
  );
}
