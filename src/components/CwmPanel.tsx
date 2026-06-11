import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  ImageIcon,
  MessageSquare,
  Paperclip,
  Plus,
  RefreshCw,
  Send,
  Square,
  Trash2,
  User,
  Video,
  AlertCircle,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useStore } from '../hooks/useStore';
import { useCwmChat } from '../hooks/useCwmChat';
import { useCwmStore } from '../lib/cwm-store';
import {
  classifyAttachment,
  validateAttachment,
  CWM_MAX_ATTACHMENTS,
  type CwmAttachment,
  type CwmComposerMode,
  type CwmMessage,
} from '../lib/cwm-types';
import { cn, genId } from '../lib/utils';

/**
 * Chat With Model — a standalone conversational mode.
 * No agent loop, no workspace/terminal access: chat, attachments and media
 * generation only. Takes over the full center+side area (like Brain).
 */
export function CwmPanel() {
  const { availableModels } = useStore();
  const cwm = useCwmStore();
  const { send, abort, generateMedia, cancelMedia } = useCwmChat();

  const [input, setInput] = useState('');
  const [mode, setMode] = useState<CwmComposerMode>('chat');
  const [dragOver, setDragOver] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [imageProviders, setImageProviders] = useState<{ id: string; label: string; hasKey: boolean }[]>([]);
  const [videoProviders, setVideoProviders] = useState<{ id: string; label: string; hasKey: boolean }[]>([]);
  const [imageProviderId, setImageProviderId] = useState('openai');
  const [videoProviderId, setVideoProviderId] = useState('openai');

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cwm.bootstrap(availableModels);
  }, [availableModels]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    (async () => {
      try {
        const [img, vid] = await Promise.all([
          window.api.cwm.imageProviders(),
          window.api.cwm.videoProviders(),
        ]);
        setImageProviders(img);
        setVideoProviders(vid);
        const savedImg = (await window.api.settings.get('cwmImageProviderId')) as string | undefined;
        const savedVid = (await window.api.settings.get('cwmVideoProviderId')) as string | undefined;
        if (savedImg && img.find((p) => p.id === savedImg)) setImageProviderId(savedImg);
        else setImageProviderId(img.find((p) => p.hasKey)?.id || img[0]?.id || 'openai');
        if (savedVid && vid.find((p) => p.id === savedVid)) setVideoProviderId(savedVid);
        else setVideoProviderId(vid.find((p) => p.hasKey)?.id || vid[0]?.id || 'openai');
      } catch {
        /* provider list is cosmetic until generation is invoked */
      }
    })();
  }, []);

  useEffect(() => {
    if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [cwm.messages]);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 200) + 'px';
    }
  }, [input]);

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      setAttachError(null);
      const s = useCwmStore.getState();
      const room = CWM_MAX_ATTACHMENTS - s.pendingAttachments.length;
      const list = Array.from(files).slice(0, Math.max(0, room));
      if (Array.from(files).length > room) {
        setAttachError(`не больше ${CWM_MAX_ATTACHMENTS} вложений на сообщение`);
      }
      const out: CwmAttachment[] = [];
      for (const f of list) {
        const kind = classifyAttachment(f.name, f.type);
        if (!kind) {
          setAttachError(`«${f.name}»: поддерживаются изображения, PDF и текстовые файлы`);
          continue;
        }
        const v = validateAttachment(kind, f.size);
        if (!v.ok) {
          setAttachError(`«${f.name}»: ${v.error}`);
          continue;
        }
        try {
          if (kind === 'text') {
            out.push({
              id: genId(),
              name: f.name,
              mediaType: f.type || 'text/plain',
              size: f.size,
              kind,
              text: await f.text(),
            });
          } else {
            const buf = await f.arrayBuffer();
            let bin = '';
            const bytes = new Uint8Array(buf);
            const CHUNK = 0x8000;
            for (let i = 0; i < bytes.length; i += CHUNK) {
              bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
            }
            out.push({
              id: genId(),
              name: f.name,
              mediaType: f.type || (kind === 'pdf' ? 'application/pdf' : 'image/png'),
              size: f.size,
              kind,
              data: btoa(bin),
            });
          }
        } catch (err: any) {
          setAttachError(`«${f.name}»: не удалось прочитать (${err?.message || err})`);
        }
      }
      if (out.length > 0) s.addAttachments(out);
    },
    []
  );

  async function handleSend() {
    const text = input.trim();
    if (mode === 'image' || mode === 'video') {
      if (!text) return;
      setInput('');
      await generateMedia(mode, mode === 'image' ? imageProviderId : videoProviderId, text);
      return;
    }
    if (!text && cwm.pendingAttachments.length === 0) return;
    setInput('');
    await send(text);
  }

  const canSend =
    mode === 'chat'
      ? !!cwm.selectedModel && (input.trim().length > 0 || cwm.pendingAttachments.length > 0)
      : input.trim().length > 0;

  return (
    <div
      className="flex flex-1 min-h-0 min-w-0"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
      }}
    >
      {/* Sessions */}
      <div className="w-64 border-r border-bg-border flex flex-col bg-bg-panel">
        <div className="px-3 py-2 border-b border-bg-border flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-text-secondary flex items-center gap-2">
            <MessageSquare className="w-3.5 h-3.5" />
            Чаты
          </h2>
          <button
            onClick={() => cwm.newSession()}
            title="Новый чат"
            className="p-1 text-text-secondary hover:text-text-primary rounded hover:bg-bg-elevated"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto py-1">
          {cwm.sessions.length === 0 && (
            <div className="text-xs text-text-muted px-3 py-4 text-center">
              История пуста. Начните разговор →
            </div>
          )}
          {cwm.sessions.map((sess) => (
            <div
              key={sess.id}
              className={cn(
                'group mx-1 px-2 py-1.5 rounded cursor-pointer flex items-start gap-2',
                sess.id === cwm.activeSessionId
                  ? 'bg-accent/10 text-text-primary'
                  : 'text-text-secondary hover:bg-bg-elevated'
              )}
              onClick={() => cwm.openSession(sess.id)}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">{sess.title}</div>
                <div className="text-[10px] text-text-muted">
                  {new Date(sess.updatedAt).toLocaleDateString()} · {sess.messageCount} сообщ.
                  {sess.model ? ` · ${sess.model}` : ''}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  cwm.deleteSession(sess.id);
                }}
                title="Удалить"
                className="opacity-0 group-hover:opacity-100 p-0.5 text-text-muted hover:text-rose-400"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Chat column */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        {dragOver && (
          <div className="absolute inset-0 z-10 bg-accent/10 border-2 border-dashed border-accent rounded-lg m-2 flex items-center justify-center pointer-events-none">
            <div className="text-accent font-medium">Отпустите, чтобы прикрепить файлы</div>
          </div>
        )}

        {/* Header */}
        <div className="px-4 py-2 border-b border-bg-border flex items-center gap-3">
          <Bot className="w-4 h-4 text-accent shrink-0" />
          <div className="text-sm font-medium truncate">{cwm.title}</div>
          <div className="flex-1" />
          <select
            value={cwm.selectedModel?.id || ''}
            onChange={(e) => {
              const m = availableModels.find((x) => x.id === e.target.value);
              if (m) cwm.setModel(m);
            }}
            className="input text-xs py-1 max-w-[280px]"
            title="Модель для разговора"
          >
            {!cwm.selectedModel && <option value="">— выберите модель —</option>}
            {availableModels.map((m) => (
              <option key={`${m.provider}:${m.id}`} value={m.id}>
                {m.displayName} ({m.provider})
              </option>
            ))}
          </select>
        </div>

        {/* Messages */}
        <div ref={messagesRef} className="flex-1 overflow-auto px-4 py-4 space-y-4">
          {cwm.messages.length === 0 && (
            <div className="text-center text-text-muted text-sm pt-16 px-8 max-w-md mx-auto">
              <Bot className="w-10 h-10 mx-auto mb-3 opacity-50" strokeWidth={1.5} />
              <p className="font-medium text-text-secondary mb-1">Просто поговорить с моделью</p>
              <p className="text-xs">
                Переписка, фото и файлы, генерация изображений и видео. Без доступа к проекту и
                инструментам — это разговорный режим.
              </p>
            </div>
          )}
          {cwm.messages.map((msg) => (
            <CwmBubble key={msg.id} msg={msg} onCancelMedia={cancelMedia} onRetryMedia={(g) => generateMedia(g.kind, g.providerId, g.prompt)} />
          ))}
        </div>

        {/* Composer */}
        <div className="p-3 border-t border-bg-border">
          {/* Mode tabs + media provider picker */}
          <div className="flex items-center gap-1 mb-2">
            {(
              [
                { id: 'chat', icon: MessageSquare, label: 'Чат' },
                { id: 'image', icon: ImageIcon, label: 'Картинка' },
                { id: 'video', icon: Video, label: 'Видео' },
              ] as const
            ).map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                onClick={() => setMode(id)}
                className={cn(
                  'px-2.5 py-1 rounded-md text-xs flex items-center gap-1.5 transition-colors',
                  mode === id
                    ? 'bg-accent/15 text-accent'
                    : 'text-text-secondary hover:text-text-primary hover:bg-bg-elevated'
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
            <div className="flex-1" />
            {mode === 'image' && (
              <select
                value={imageProviderId}
                onChange={(e) => {
                  setImageProviderId(e.target.value);
                  window.api.settings.set('cwmImageProviderId', e.target.value).catch(() => {});
                }}
                className="input text-xs py-1"
              >
                {imageProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}{p.hasKey ? '' : ' — нет ключа'}
                  </option>
                ))}
              </select>
            )}
            {mode === 'video' && (
              <select
                value={videoProviderId}
                onChange={(e) => {
                  setVideoProviderId(e.target.value);
                  window.api.settings.set('cwmVideoProviderId', e.target.value).catch(() => {});
                }}
                className="input text-xs py-1"
              >
                {videoProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}{p.hasKey ? '' : ' — нет ключа'}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Pending attachments */}
          {mode === 'chat' && cwm.pendingAttachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {cwm.pendingAttachments.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center gap-1.5 bg-bg-elevated rounded-md pl-1.5 pr-1 py-1 text-xs"
                >
                  {a.kind === 'image' && a.data ? (
                    <img
                      src={`data:${a.mediaType};base64,${a.data}`}
                      alt={a.name}
                      className="w-8 h-8 object-cover rounded"
                    />
                  ) : (
                    <FileText className="w-4 h-4 text-text-secondary" />
                  )}
                  <span className="max-w-[140px] truncate" title={a.name}>
                    {a.name}
                  </span>
                  <span className="text-text-muted">{Math.max(1, Math.round(a.size / 1024))} КБ</span>
                  <button
                    onClick={() => cwm.removeAttachment(a.id)}
                    className="p-0.5 text-text-muted hover:text-rose-400"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {attachError && (
            <div className="text-xs text-rose-400 mb-2 flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" /> {attachError}
            </div>
          )}

          <div className="relative">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (cwm.isStreaming && mode === 'chat') return;
                  handleSend();
                }
              }}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData?.files || []);
                if (files.length > 0 && mode === 'chat') {
                  e.preventDefault();
                  addFiles(files);
                }
              }}
              placeholder={
                mode === 'image'
                  ? 'Опишите изображение, которое нужно сгенерировать…'
                  : mode === 'video'
                  ? 'Опишите видео (генерация занимает несколько минут)…'
                  : cwm.selectedModel
                  ? `Сообщение в ${cwm.selectedModel.displayName}…`
                  : 'Выберите модель сверху'
              }
              className="input resize-none pr-20 min-h-[44px] max-h-[200px]"
              rows={1}
            />
            {mode === 'chat' && (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/*,.md,.json,.csv,.ts,.tsx,.js,.py,.yaml,.yml"
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files?.length) addFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
                <button
                  onClick={() => fileRef.current?.click()}
                  title="Прикрепить файл"
                  className="absolute right-11 bottom-2 p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-elevated"
                >
                  <Paperclip className="w-4 h-4" />
                </button>
              </>
            )}
            <button
              onClick={cwm.isStreaming && mode === 'chat' ? abort : handleSend}
              disabled={!cwm.isStreaming && !canSend}
              className={cn(
                'absolute right-2 bottom-2 p-1.5 rounded-md transition-colors',
                cwm.isStreaming && mode === 'chat'
                  ? 'bg-rose-500/15 text-rose-400 hover:bg-rose-500/25'
                  : 'bg-accent text-bg hover:bg-accent-hover disabled:opacity-40'
              )}
            >
              {cwm.isStreaming && mode === 'chat' ? <Square className="w-3.5 h-3.5" /> : <Send className="w-3.5 h-3.5" />}
            </button>
          </div>
          <div className="text-xs text-text-muted mt-1 px-1">
            {mode === 'chat'
              ? 'Enter — отправить · Shift+Enter — новая строка · файлы можно перетащить'
              : mode === 'image'
              ? 'Генерация через внешний API провайдера (нужен ключ в Settings → Providers)'
              : 'Видео генерируется асинхронно через внешний API — следите за прогрессом в карточке'}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Message bubble ───────────────────────────────────────────

function CwmBubble({
  msg,
  onCancelMedia,
  onRetryMedia,
}: {
  msg: CwmMessage;
  onCancelMedia: (jobId: string) => void;
  onRetryMedia: (gen: NonNullable<CwmMessage['gen']>) => void;
}) {
  const [showThinking, setShowThinking] = useState(false);

  if (msg.role === 'user') {
    return (
      <div className="flex gap-2 max-w-3xl">
        <div className="w-6 h-6 rounded-full bg-bg-elevated flex items-center justify-center shrink-0 mt-0.5">
          <User className="w-3.5 h-3.5 text-text-secondary" />
        </div>
        <div className="flex-1 min-w-0">
          {msg.attachments && msg.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-1.5">
              {msg.attachments.map((a) => (
                <div key={a.id} className="bg-bg-elevated rounded-md overflow-hidden">
                  {a.kind === 'image' && a.data ? (
                    <img
                      src={`data:${a.mediaType};base64,${a.data}`}
                      alt={a.name}
                      className="max-w-[200px] max-h-[160px] object-contain"
                    />
                  ) : (
                    <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-text-secondary">
                      <FileText className="w-3.5 h-3.5" /> {a.name}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="text-sm text-text-primary whitespace-pre-wrap break-words">{msg.content}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2 max-w-3xl">
      <div className="w-6 h-6 rounded-full bg-accent/15 flex items-center justify-center shrink-0 mt-0.5">
        <Bot className="w-3.5 h-3.5 text-accent" />
      </div>
      <div className="flex-1 min-w-0">
        {msg.gen ? (
          <GenJobCard gen={msg.gen} onCancel={onCancelMedia} onRetry={onRetryMedia} />
        ) : (
          <>
            {msg.thinking && (
              <button
                onClick={() => setShowThinking((v) => !v)}
                className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary mb-1"
              >
                {showThinking ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                <Brain className="w-3 h-3" />
                Мышление
              </button>
            )}
            {showThinking && msg.thinking && (
              <div className="text-xs text-text-muted bg-bg-elevated rounded p-2 mb-2 whitespace-pre-wrap font-mono border-l-2 border-accent-muted">
                {msg.thinking}
              </div>
            )}
            {msg.error ? (
              <div className="flex items-start gap-2 text-rose-400 text-sm bg-rose-500/10 rounded p-2 border border-rose-500/20">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <div>{msg.error}</div>
              </div>
            ) : (
              <div className="markdown-body break-words">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {msg.content || (msg.streaming ? '…' : '')}
                </ReactMarkdown>
                {msg.streaming && <span className="inline-block w-1.5 h-3 bg-accent ml-0.5 animate-pulse" />}
              </div>
            )}
            {msg.model && !msg.streaming && <div className="text-xs text-text-muted mt-1">{msg.model}</div>}
          </>
        )}
      </div>
    </div>
  );
}

// ── Media generation card ────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  queued: 'В очереди…',
  generating: 'Генерация…',
  done: 'Готово',
  failed: 'Ошибка',
  cancelled: 'Отменено',
};

function GenJobCard({
  gen,
  onCancel,
  onRetry,
}: {
  gen: NonNullable<CwmMessage['gen']>;
  onCancel: (jobId: string) => void;
  onRetry: (gen: NonNullable<CwmMessage['gen']>) => void;
}) {
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const running = gen.status === 'queued' || gen.status === 'generating';

  async function loadVideo() {
    if (!gen.filePath || videoSrc) return;
    setVideoLoading(true);
    try {
      const res = await window.api.cwm.readMedia(gen.filePath);
      if (res.ok && res.base64) setVideoSrc(`data:${gen.mediaType || 'video/mp4'};base64,${res.base64}`);
    } finally {
      setVideoLoading(false);
    }
  }

  return (
    <div className="bg-bg-elevated rounded-lg p-3 max-w-md">
      <div className="flex items-center gap-2 text-xs mb-2">
        {gen.kind === 'image' ? (
          <ImageIcon className="w-3.5 h-3.5 text-accent" />
        ) : (
          <Video className="w-3.5 h-3.5 text-accent" />
        )}
        <span
          className={cn(
            'chip',
            gen.status === 'done'
              ? 'bg-emerald-500/15 text-emerald-400'
              : gen.status === 'failed'
              ? 'bg-rose-500/15 text-rose-400'
              : 'bg-accent/10 text-accent'
          )}
        >
          {STATUS_LABEL[gen.status] || gen.status}
          {gen.status === 'generating' && typeof gen.percent === 'number' ? ` ${gen.percent}%` : ''}
        </span>
        <span className="text-text-muted truncate flex-1" title={gen.prompt}>
          {gen.prompt}
        </span>
      </div>

      {running && (
        <div className="h-1.5 bg-bg rounded overflow-hidden mb-2">
          <div
            className={cn('h-full bg-accent rounded transition-all', typeof gen.percent !== 'number' && 'animate-pulse w-full opacity-40')}
            style={typeof gen.percent === 'number' ? { width: `${Math.max(3, gen.percent)}%` } : undefined}
          />
        </div>
      )}

      {gen.status === 'failed' && (
        <div className="text-xs text-rose-400 mb-2 break-words">{gen.error}</div>
      )}

      {gen.status === 'done' && gen.kind === 'image' && gen.base64 && (
        <img
          src={`data:${gen.mediaType || 'image/png'};base64,${gen.base64}`}
          alt={gen.prompt}
          className="rounded-md max-w-full mb-2"
        />
      )}
      {gen.status === 'done' && gen.kind === 'video' && (
        <div className="mb-2">
          {videoSrc ? (
            <video src={videoSrc} controls className="rounded-md max-w-full" />
          ) : (
            <button
              onClick={loadVideo}
              disabled={videoLoading}
              className="px-3 py-1.5 text-xs rounded-md bg-bg text-text-secondary hover:text-text-primary"
            >
              {videoLoading ? 'Загрузка…' : '▶ Показать видео'}
            </button>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        {running && (
          <button
            onClick={() => onCancel(gen.jobId)}
            className="px-2.5 py-1 text-xs rounded-md bg-rose-500/15 text-rose-400 hover:bg-rose-500/25"
          >
            Отменить
          </button>
        )}
        {gen.status === 'done' && gen.filePath && (
          <button
            onClick={() => window.api.cwm.saveMediaAs(gen.filePath!)}
            className="px-2.5 py-1 text-xs rounded-md bg-bg text-text-secondary hover:text-text-primary flex items-center gap-1"
          >
            <Download className="w-3 h-3" /> Сохранить как…
          </button>
        )}
        {(gen.status === 'failed' || gen.status === 'cancelled' || gen.status === 'done') && (
          <button
            onClick={() => onRetry(gen)}
            className="px-2.5 py-1 text-xs rounded-md bg-bg text-text-secondary hover:text-text-primary flex items-center gap-1"
          >
            <RefreshCw className="w-3 h-3" /> Повторить
          </button>
        )}
      </div>
    </div>
  );
}
