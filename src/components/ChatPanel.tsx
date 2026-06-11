import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Send, Square, Trash2, Brain, Bot, AlertCircle, ChevronDown, ChevronRight,
  Check, X, FileText, FilePlus, FilePen, FileX, Search, Terminal, FolderOpen, Globe, Wrench,
  type LucideIcon,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useStore } from '../hooks/useStore';
import { useChat } from '../hooks/useChat';
import { formatHelpMarkdown, getSuggestions, parseSlashCommand } from '../lib/slash-router';
import { runImageCommand } from '../lib/image-runner';
import { runOpusPlan } from '../lib/opus-plan-runner';
import { runMultyplan, approveMultyplan, rejectMultyplan } from '../lib/multyplan-runner';
import { cancelUltrathink, parseUltrathinkCommand, runUltrathink } from '../lib/ultrathink-runner';
import { runCdesign } from '../lib/cdesign-runner';
import { runBrain } from '../lib/brain-runner';
import { cn, genId, relativePath } from '../lib/utils';
import type { ChatMessage, ToolEvent } from '../types';

export function ChatPanel() {
  const { messages, isStreaming, clearChat, selectedModel, chatMode, setChatMode, addMessage, setActivePanel, workspaceRoot, refreshFileTree, activeFilePath, openFiles, availableModels, setModel } = useStore();
  const { send, abort } = useChat();
  const stopActiveRun = async () => {
    if (await cancelUltrathink()) return;
    abort();
  };
  const [input, setInput] = useState('');
  const [showThinking, setShowThinking] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);

  // Auto-scroll
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages]);

  // Auto-grow textarea
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 200) + 'px';
    }
  }, [input]);

  const suggestions = getSuggestions(input.split('\n')[0]);
  const parsedInputSlash = parseSlashCommand(input.trim());
  const inputNeedsSelectedModel = !parsedInputSlash || parsedInputSlash.kind === 'ask';

  function postAssistant(content: string) {
    addMessage({ id: genId(), role: 'assistant', content, timestamp: Date.now() });
  }

  function postUser(content: string) {
    addMessage({ id: genId(), role: 'user', content, timestamp: Date.now() });
  }

  function latestPendingMultyplanRequestId(): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const approval = messages[i].awaitingApproval;
      if (approval && !approval.resolved) return approval.requestId;
    }
    return null;
  }

  async function handleSend() {
    const text = input.trim();
    if (!text) return;

    const slash = parseSlashCommand(text);

    // Allow /stop and /clear even while streaming.
    if (slash?.kind === 'stop') {
      setInput('');
      const res = await window.api.ai.stop();
      if (await cancelUltrathink()) {
        // ultrathink also handles its own cancel
      } else if (!res.cancelled) {
        abort();
      }
      postAssistant('Cancellation requested.');
      return;
    }

    if (slash?.kind === 'clear') {
      clearChat();
      setInput('');
      return;
    }

    if (isStreaming) return;

    // ── Pure-UI commands that don't hit the model ─────────
    if (slash?.kind === 'help') {
      postUser(text);
      postAssistant(formatHelpMarkdown());
      setInput('');
      return;
    }
    if (slash?.kind === 'settings') {
      setActivePanel('settings');
      setInput('');
      return;
    }
    if (slash?.kind === 'models') {
      postUser(text);
      if (availableModels.length === 0) {
        postAssistant('No models available. Install one in Settings, or start Ollama.');
      } else {
        const lines = availableModels.map(
          (m) => `- \`${m.id}\` (${m.provider})`
        );
        postAssistant(`Available models:\n\n${lines.join('\n')}\n\nUse \`/model <id>\` to switch.`);
      }
      setInput('');
      return;
    }
    if (slash?.kind === 'model') {
      const id = slash.args.trim();
      if (!id) {
        postUser(text);
        postAssistant('Usage: `/model <id>`');
      } else {
        const found = availableModels.find((m) => m.id === id);
        if (!found) {
          postUser(text);
          postAssistant(`Unknown model: ${id}`);
        } else {
          setModel(found);
          await window.api.settings.set('selectedModelId', found.id);
          postAssistant(`Switched to \`${found.displayName}\`.`);
        }
      }
      setInput('');
      return;
    }
    if (slash?.kind === 'index') {
      setInput('');
      postUser(text);
      if (!workspaceRoot) {
        postAssistant('Open a project folder first.');
        return;
      }
      await refreshFileTree();
      postAssistant('Workspace re-indexed.');
      return;
    }

    if (slash?.kind === 'design') {
      setChatMode('design');
      setInput('');
      postAssistant('Design critique mode enabled. Share UI code or a screenshot.');
      return;
    }
    if (slash?.kind === 'cdesign') {
      setInput('');
      setChatMode('cdesign');
      await runCdesign(slash.args);
      return;
    }
    if (slash?.kind === 'brain') {
      setInput('');
      await runBrain(slash.args);
      return;
    }

    if (slash?.kind === 'image') {
      setInput('');
      await runImageCommand(slash.args);
      return;
    }
    if (slash?.kind === 'plan') {
      setInput('');
      await runOpusPlan(slash.args);
      return;
    }
    if (slash?.kind === 'multyplan') {
      setInput('');
      await runMultyplan(slash.args);
      return;
    }
    if (slash?.kind === 'multyplanApprove') {
      setInput('');
      postUser(text);
      const requestId = latestPendingMultyplanRequestId();
      if (!requestId) {
        postAssistant('No pending /multyplan plan to approve.');
        return;
      }
      await approveMultyplan(requestId);
      return;
    }
    if (slash?.kind === 'multyplanReject') {
      setInput('');
      postUser(text);
      const requestId = latestPendingMultyplanRequestId();
      if (!requestId) {
        postAssistant('No pending /multyplan plan to reject.');
        return;
      }
      await rejectMultyplan(requestId);
      return;
    }
    if (slash?.kind === 'ultrathink') {
      setInput('');
      const choice = slash.variant === 'gemma'
        ? 'gemma'
        : slash.variant === 'deepseek'
        ? 'deepseek'
        : parseUltrathinkCommand(slash.command);
      await runUltrathink(slash.args, choice);
      return;
    }

    // ── Code-action commands that route through the chat ──
    if (slash?.kind === 'ask') {
      setInput('');
      const q = slash.args.trim();
      if (!q) {
        postAssistant('Usage: `/ask <question>` — answers using project context; no file edits.');
        return;
      }
      await send(`Question (project-aware, no edits): ${q}`, {
        forceChat: true,
        systemSuffix: 'You are in ASK mode. Do NOT call any tools. Do NOT propose patches. Only explain.',
        echoText: `/ask ${q}`,
      });
      return;
    }
    if (slash?.kind === 'edit') {
      setInput('');
      const instr = slash.args.trim();
      const target = activeFilePath ? relativePath(activeFilePath, workspaceRoot) : null;
      if (!instr) {
        postAssistant('Usage: `/edit <instruction>` — edits the active file or files relevant to the instruction.');
        return;
      }
      await send(
        target
          ? `Edit the active file (${target}). Instruction: ${instr}`
          : `Edit relevant project files. Instruction: ${instr}`,
        { echoText: `/edit ${instr}` }
      );
      return;
    }
    if (slash?.kind === 'fix') {
      setInput('');
      const sym = slash.args.trim();
      if (!sym) {
        postAssistant('Usage: `/fix <bug symptom>` — investigates and fixes.');
        return;
      }
      await send(`Find and fix this bug: ${sym}\nRead relevant files first, then make minimal surgical edits.`, {
        echoText: `/fix ${sym}`,
      });
      return;
    }
    if (slash?.kind === 'review') {
      setInput('');
      const target = slash.args.trim();
      const scope = target || (activeFilePath ? relativePath(activeFilePath, workspaceRoot) : 'the current project');
      await send(
        `Review ${scope} for bugs, unsafe patterns, dead code, and weak spots. Do NOT modify files in this command — analysis only.`,
        {
          forceChat: true,
          systemSuffix: 'You are in REVIEW mode. Do NOT call tools. Produce a structured review.',
          echoText: `/review ${target || scope}`,
        }
      );
      return;
    }
    if (slash?.kind === 'explain') {
      setInput('');
      const target = slash.args.trim() || (activeFilePath ? relativePath(activeFilePath, workspaceRoot) : '');
      if (!target && openFiles.length === 0) {
        postAssistant('Usage: `/explain <file or symbol>` — opens a file first if nothing is selected.');
        return;
      }
      await send(`Explain ${target || 'the active file'} clearly. No edits.`, {
        forceChat: true,
        systemSuffix: 'You are in EXPLAIN mode. Do NOT call tools. Produce a clear explanation.',
        echoText: `/explain ${target}`,
      });
      return;
    }
    if (slash?.kind === 'test') {
      setInput('');
      const target = slash.args.trim() || (activeFilePath ? relativePath(activeFilePath, workspaceRoot) : '');
      if (!target) {
        postAssistant('Usage: `/test <file>` or open a file first.');
        return;
      }
      await send(`Suggest concrete tests for ${target}. If a sibling test file exists, edit it; otherwise create one.`, {
        echoText: `/test ${target}`,
      });
      return;
    }
    if (slash?.kind === 'commit') {
      setInput('');
      await send(
        'Read the recently modified files and propose a single concise commit message (one subject line ≤72 chars, optional body). Do NOT modify any file.',
        {
          forceChat: true,
          systemSuffix: 'You are in COMMIT mode. Do NOT call tools. Output the commit message only.',
          echoText: '/commit',
        }
      );
      return;
    }

    setInput('');
    await send(text);
  }

  return (
    <div className="w-[420px] border-l border-bg-border flex flex-col bg-bg-panel">
      {/* Header */}
      <div className="px-3 py-2 border-b border-bg-border flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-text-secondary flex items-center gap-2">
          <Bot className="w-3.5 h-3.5" />
          AI Чат
          {chatMode !== 'code' && (
            <span className="chip bg-accent/10 text-accent">{chatMode}</span>
          )}
        </h2>
        <button
          onClick={clearChat}
          title="Очистить чат"
          className="p-1 text-text-secondary hover:text-text-primary rounded hover:bg-bg-elevated"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Messages */}
      <div ref={messagesRef} className="flex-1 overflow-auto px-3 py-3 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-text-muted text-sm pt-8 px-4">
            <Bot className="w-8 h-8 mx-auto mb-3 opacity-50" strokeWidth={1.5} />
            <p>Start a conversation.</p>
            <p className="text-xs mt-2">Type <code className="text-accent">/help</code> for the command list.</p>
          </div>
        )}
        {messages.length > 60 && (
          <div className="text-[10px] text-text-muted text-center">
            Showing last 60 of {messages.length} messages.
          </div>
        )}
        {messages.slice(-60).map((msg) => (
          <MessageBubble
            key={msg.id}
            msg={msg}
            showThinking={showThinking.has(msg.id)}
            onToggleThinking={() =>
              setShowThinking((s) => {
                const next = new Set(s);
                if (next.has(msg.id)) next.delete(msg.id);
                else next.add(msg.id);
                return next;
              })
            }
          />
        ))}
      </div>

      {/* Slash suggestions */}
      {suggestions.length > 0 && input.startsWith('/') && (
        <div className="border-t border-bg-border bg-bg max-h-48 overflow-auto">
          {suggestions.map((s) => (
            <button
              key={s.name}
              onClick={() => {
                setInput(s.name + ' ');
                inputRef.current?.focus();
              }}
              className="w-full px-3 py-2 text-left hover:bg-bg-elevated flex items-start gap-2 text-sm"
            >
              <div className="flex-1 min-w-0">
                <div className="font-mono text-accent">{s.name}</div>
                <div className="text-xs text-text-muted">{s.description}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="p-3 border-t border-bg-border">
        <div className="relative">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={selectedModel ? `Сообщение в ${selectedModel.displayName}...` : 'Выберите модель сначала'}
            className="input resize-none pr-10 min-h-[40px] max-h-[200px]"
            rows={1}
          />
          <button
            onClick={isStreaming ? stopActiveRun : handleSend}
            disabled={!isStreaming && (!input.trim() || (inputNeedsSelectedModel && !selectedModel))}
            className={cn(
              'absolute right-2 bottom-2 p-1.5 rounded-md transition-colors',
              isStreaming
                ? 'bg-rose-500/15 text-rose-400 hover:bg-rose-500/25'
                : 'bg-accent text-bg hover:bg-accent-hover disabled:opacity-40'
            )}
          >
            {isStreaming ? <Square className="w-3.5 h-3.5" /> : <Send className="w-3.5 h-3.5" />}
          </button>
        </div>
        <div className="text-xs text-text-muted mt-1 px-1">
          Enter — отправить · Shift+Enter — новая строка
        </div>
      </div>
    </div>
  );
}

/** Map a tool name onto a line icon (single lucide stroke set). */
function toolIcon(tool: string): LucideIcon {
  const t = tool.toLowerCase();
  if (t.includes('read')) return FileText;
  if (t.includes('create') || t.includes('write')) return FilePlus;
  if (t.includes('edit') || t.includes('apply') || t.includes('patch')) return FilePen;
  if (t.includes('delete') || t.includes('remove')) return FileX;
  if (t.includes('search') || t.includes('grep') || t.includes('glob') || t.includes('find')) return Search;
  if (t.includes('run') || t.includes('exec') || t.includes('bash') || t.includes('command') || t.includes('terminal')) return Terminal;
  if (t.includes('list') || t.includes('dir') || t.includes('tree')) return FolderOpen;
  if (t.includes('fetch') || t.includes('http') || t.includes('web') || t.includes('url')) return Globe;
  return Wrench;
}

const STATUS_LABEL: Record<ToolEvent['status'], string> = {
  running: 'running',
  done: 'done',
  error: 'error',
};

const OUTPUT_PREVIEW_LINES = 12;

function ToolCallBlock({ ev }: { ev: ToolEvent }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const Icon = toolIcon(ev.tool);
  const hasOutput = !!ev.output?.trim();

  const lines = (ev.output || '').split('\n');
  const truncated = !showAll && lines.length > OUTPUT_PREVIEW_LINES;
  const visibleOutput = truncated ? lines.slice(0, OUTPUT_PREVIEW_LINES).join('\n') : ev.output;

  return (
    <div
      className={cn(
        'my-2 rounded border border-bg-subtle bg-bg-elevated border-l-2 overflow-hidden',
        ev.status === 'running' && 'border-l-status-running',
        ev.status === 'done' && 'border-l-status-done',
        ev.status === 'error' && 'border-l-status-error'
      )}
    >
      <button
        onClick={() => hasOutput && setOpen((o) => !o)}
        className={cn(
          'w-full flex items-center gap-2 px-2 py-1.5 text-left',
          hasOutput ? 'cursor-pointer hover:bg-bg-border/30' : 'cursor-default',
          ev.status === 'error' && 'bg-status-error/[0.06]'
        )}
      >
        <Icon className="w-3.5 h-3.5 shrink-0 text-text-secondary" strokeWidth={1.75} />
        <span className="font-mono text-xs truncate flex-1 min-w-0">
          <span className="text-text-primary">{ev.tool}</span>
          {ev.target && <span className="text-text-secondary"> {ev.target}</span>}
        </span>
        <span className="flex items-center gap-1.5 shrink-0">
          <span
            className={cn(
              'w-1.5 h-1.5 rounded-full',
              ev.status === 'running' && 'bg-status-running animate-pulse',
              ev.status === 'done' && 'bg-status-done',
              ev.status === 'error' && 'bg-status-error'
            )}
          />
          <span className="font-mono text-[11px] text-text-muted">{STATUS_LABEL[ev.status]}</span>
        </span>
        {hasOutput &&
          (open ? (
            <ChevronDown className="w-3 h-3 shrink-0 text-text-muted" />
          ) : (
            <ChevronRight className="w-3 h-3 shrink-0 text-text-muted" />
          ))}
      </button>
      {open && hasOutput && (
        <div className="border-t border-bg-subtle bg-bg-inset">
          <pre className="px-2.5 py-2 font-mono text-xs leading-relaxed text-text-secondary whitespace-pre-wrap break-words overflow-x-auto max-h-72 overflow-y-auto">
            {visibleOutput}
          </pre>
          {truncated && (
            <button
              onClick={() => setShowAll(true)}
              className="w-full px-2.5 pb-2 font-mono text-[11px] text-text-muted hover:text-text-secondary text-left"
            >
              … ещё {lines.length - OUTPUT_PREVIEW_LINES} строк — показать всё
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Shared markdown renderer for assistant prose chunks. */
function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ inline, className, children, ...props }: any) {
          const match = /language-(\w+)/.exec(className || '');
          if (!inline && match) {
            return (
              <SyntaxHighlighter
                style={vscDarkPlus as any}
                language={match[1]}
                PreTag="div"
                customStyle={{
                  margin: 0,
                  background: '#0d1117',
                  fontSize: '12px',
                }}
              >
                {String(children).replace(/\n$/, '')}
              </SyntaxHighlighter>
            );
          }
          return (
            <code className={className} {...props}>
              {children}
            </code>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

/** Interleaves assistant prose with tool-call blocks using event anchors. */
function AssistantBody({ msg }: { msg: ChatMessage }) {
  const events = msg.toolEvents || [];
  if (events.length === 0) {
    return <Markdown text={msg.content || (msg.streaming ? '…' : '')} />;
  }
  const parts: ReactNode[] = [];
  let pos = 0;
  events.forEach((ev, i) => {
    const anchor = Math.min(Math.max(ev.anchor, pos), msg.content.length);
    const chunk = msg.content.slice(pos, anchor);
    if (chunk.trim()) parts.push(<Markdown key={`t-${i}`} text={chunk} />);
    parts.push(<ToolCallBlock key={ev.id} ev={ev} />);
    pos = anchor;
  });
  const tail = msg.content.slice(pos);
  if (tail.trim()) parts.push(<Markdown key="tail" text={tail} />);
  return <>{parts}</>;
}

function MessageBubble({
  msg,
  showThinking,
  onToggleThinking,
}: {
  msg: ChatMessage;
  showThinking: boolean;
  onToggleThinking: () => void;
}) {
  if (msg.role === 'user') {
    return (
      <div className="border-l-2 border-accent pl-3">
        <div className="font-mono text-[11px] text-text-muted mb-0.5">you</div>
        <div className="text-[13px] leading-relaxed text-text-primary whitespace-pre-wrap break-words">
          {msg.content}
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      {msg.thinking && (
        <button
          onClick={onToggleThinking}
          className="flex items-center gap-1 font-mono text-[11px] text-text-muted hover:text-text-secondary mb-1"
        >
          {showThinking ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          <Brain className="w-3 h-3" strokeWidth={1.75} />
          мышление · {msg.thinking.split('\n').length} стр
        </button>
      )}
      {showThinking && msg.thinking && (
        <div className="text-xs leading-relaxed text-text-secondary border-l border-bg-subtle pl-3 mb-2 whitespace-pre-wrap">
          {msg.thinking}
        </div>
      )}
      {msg.error ? (
        <div className="flex items-start gap-2 text-status-error text-[13px] bg-status-error/[0.06] rounded p-2 border border-status-error/20">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.75} />
          <div>{msg.error}</div>
        </div>
      ) : (
        <div className="markdown-body break-words">
          <AssistantBody msg={msg} />
          {msg.streaming && (
            <span className="inline-block w-1.5 h-3 bg-accent ml-0.5 animate-pulse" />
          )}
        </div>
      )}
      {msg.awaitingApproval && !msg.awaitingApproval.resolved && (
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => approveMultyplan(msg.awaitingApproval!.requestId)}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-bg hover:bg-accent-hover inline-flex items-center gap-1.5"
          >
            <Check className="w-3.5 h-3.5" strokeWidth={2} />
            Утвердить план → запустить Qwen3-Coder
          </button>
          <button
            onClick={() => rejectMultyplan(msg.awaitingApproval!.requestId)}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-bg-elevated text-text-secondary hover:text-text-primary inline-flex items-center gap-1.5"
          >
            <X className="w-3.5 h-3.5" strokeWidth={2} />
            Отклонить
          </button>
        </div>
      )}
      {msg.awaitingApproval?.resolved && (
        <div className="mt-2 text-xs text-text-muted italic">
          {msg.awaitingApproval.resolved === 'approved'
            ? 'План утверждён.'
            : 'План отклонён.'}
        </div>
      )}
      {msg.ultrathinkRequestId && msg.streaming && (
        <div className="mt-2">
          <button
            onClick={() => cancelUltrathink()}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-bg-elevated text-text-secondary hover:text-text-primary"
          >
            Cancel ultrathink
          </button>
        </div>
      )}
      {msg.model && !msg.streaming && (
        <div className="font-mono text-[11px] text-text-muted mt-1.5">{msg.model}</div>
      )}
    </div>
  );
}
