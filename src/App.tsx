import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { EditorArea } from './components/EditorArea';
import { ChatPanel } from './components/ChatPanel';
import { FileTreePanel } from './components/FileTreePanel';
import { ImageGenPanel } from './components/ImageGenPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { OnboardingDialog } from './components/OnboardingDialog';
import { ModelSelectorBar } from './components/ModelSelectorBar';
import { TerminalApprovalDialog } from './components/TerminalApprovalDialog';
import { UpdateBanner } from './components/UpdateBanner';
import { BrainPanel } from './components/BrainPanel';
import { useStore } from './hooks/useStore';
import { useBrainStore } from './lib/brain-store';

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function App() {
  const {
    activePanel,
    needsOnboarding,
    setNeedsOnboarding,
    setHasAnthropicKey,
    setAvailableModels,
    setModel,
    selectedModel,
  } = useStore();
  const [bootChecked, setBootChecked] = useState(false);
  const bootstrapBrain = useBrainStore((s) => s.bootstrap);

  // Bootstrap Brain store as soon as the app mounts. Idempotent.
  useEffect(() => {
    bootstrapBrain();
  }, [bootstrapBrain]);

  // Initial boot: check anthropic key + ollama models + persisted settings
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const hasKey = await withTimeout(window.api.anthropic.hasKey(), 1500, false);
        if (cancelled) return;
        setHasAnthropicKey(hasKey);

        // Auto-launch Ollama if needed, then probe. ensureRunning is
        // idempotent and resolves quickly when Ollama is already up.
        let ollamaHealth = await withTimeout(
          window.api.ollama.health(),
          2000,
          { ok: false, error: 'Ollama boot check timed out' }
        );
        if (!ollamaHealth.ok && !cancelled) {
          await withTimeout(window.api.ollama.ensureRunning(), 14_000, {
            ok: false,
            error: 'auto-start timed out',
          } as any);
          if (!cancelled) {
            ollamaHealth = await withTimeout(window.api.ollama.health(), 2000, {
              ok: false,
              error: 'Ollama boot check timed out',
            });
          }
        }
        if (cancelled) return;

        let availableModels: any[] = [];
        if (ollamaHealth.ok) {
          const models = await withTimeout(window.api.ollama.list(), 3000, []);
          if (cancelled) return;
          availableModels = models.map((m: any) => ({
            id: m.name,
            displayName: m.name,
            provider: 'ollama' as const,
          }));
        }
        // Cloud models: cached lists from every provider with a stored key
        // (no network at boot — lists refresh when a key is saved/refreshed).
        const cloudModels = await withTimeout(window.api.providers.allModels(), 3000, []);
        if (cancelled) return;
        if (cloudModels.length > 0) {
          availableModels.unshift(
            ...cloudModels.map((m: any) => ({
              id: m.id,
              displayName: m.displayName || m.id,
              provider: m.provider,
            }))
          );
        } else if (hasKey) {
          // Legacy fallback: anthropic key saved before the providers layer.
          availableModels.unshift({
            id: 'claude-opus-4-7',
            displayName: 'Claude Opus 4.7 (API)',
            provider: 'anthropic' as const,
          });
        }
        setAvailableModels(availableModels);

        // Pick saved or first model
        const savedModelId = await withTimeout(
          window.api.settings.get('selectedModelId') as Promise<string | undefined>,
          1500,
          undefined
        );
        if (cancelled) return;
        const saved = availableModels.find((m) => m.id === savedModelId);
        if (saved) setModel(saved);
        else if (availableModels.length > 0) setModel(availableModels[0]);

        // Restore last workspace
        const lastWorkspace = (await withTimeout(
          window.api.settings.get('lastWorkspaceRoot'),
          1500,
          null
        )) as string | null;
        if (lastWorkspace && !cancelled) {
          await window.api.workspace.setRoot(lastWorkspace);
          window.api.brain.setProject(lastWorkspace).catch(() => {});
        }

        const onboardingDone = await withTimeout(window.api.settings.get('onboardingDone'), 1500, false);
        if (cancelled) return;
        setNeedsOnboarding(!onboardingDone);
      } catch (err) {
        console.error('Boot failed, opening UI anyway:', err);
        setNeedsOnboarding(true);
      } finally {
        if (!cancelled) setBootChecked(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Persist selected model
  useEffect(() => {
    if (selectedModel) {
      window.api.settings.set('selectedModelId', selectedModel.id);
    }
  }, [selectedModel]);

  if (!bootChecked) {
    return (
      <div className="flex items-center justify-center h-full bg-bg">
        <div className="text-text-secondary">Загрузка CodeDert...</div>
      </div>
    );
  }

  // The Brain tab takes over the full center+side area. All other tabs use
  // the classic Files/Editor/Chat layout.
  if (activePanel === 'brain') {
    return (
      <div className="flex flex-col h-full bg-bg">
        <UpdateBanner />
        <div className="flex flex-1 min-h-0">
          <Sidebar />
          <BrainPanel />
          <ChatPanel />
        </div>
        {needsOnboarding && <OnboardingDialog />}
        <TerminalApprovalDialog />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-bg">
      <UpdateBanner />
      <div className="flex flex-1 min-h-0">
      {/* Left sidebar: panel switcher */}
      <Sidebar />

      {/* Panel area (Files / ImageGen / Settings) */}
      {activePanel !== 'chat' && (
        <div className="w-72 border-r border-bg-border flex flex-col bg-bg-panel">
          {activePanel === 'files' && <FileTreePanel />}
          {activePanel === 'image' && <ImageGenPanel />}
          {activePanel === 'settings' && <SettingsPanel />}
        </div>
      )}

      {/* Main column: model selector bar + editor */}
      <div className="flex-1 flex flex-col min-w-0">
        <ModelSelectorBar />
        <EditorArea />
      </div>

      {/* Chat panel on the right */}
      <ChatPanel />
      </div>

      {/* Onboarding modal */}
      {needsOnboarding && <OnboardingDialog />}

      {/* Terminal approval prompts (rendered above everything) */}
      <TerminalApprovalDialog />
    </div>
  );
}
