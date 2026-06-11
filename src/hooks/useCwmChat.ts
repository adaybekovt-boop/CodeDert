import { useEffect, useRef } from 'react';
import { genId } from '../lib/utils';
import { useCwmStore } from '../lib/cwm-store';
import type { CwmAttachment, CwmMessage } from '../lib/cwm-types';

/**
 * Chat With Model — streaming chat hook.
 *
 * Reuses the existing provider/ollama channels (plain chat, no tool
 * definitions, no workspace context). Chunk listeners are filtered by this
 * hook's own requestIds, so they never collide with the IDE chat.
 */

const CWM_SYSTEM_PROMPT = [
  'You are a friendly, knowledgeable conversational assistant inside CodeDert\'s "Chat" mode.',
  'This is a casual conversation mode: you have NO access to the user\'s project, files or tools.',
  'Never claim you can edit files or run commands. Answer in the user\'s language.',
].join(' ');

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string }
  | { type: 'document'; mediaType: string; data: string; name?: string };

function attachmentNote(atts: CwmAttachment[]): string {
  if (atts.length === 0) return '';
  return `\n\n[Вложения: ${atts.map((a) => a.name).join(', ')}]`;
}

/** Pack one CWM message into provider content parts (cloud path). */
function toParts(text: string, atts: CwmAttachment[]): string | ContentPart[] {
  if (atts.length === 0) return text;
  const parts: ContentPart[] = [];
  for (const a of atts) {
    if (a.kind === 'image' && a.data) {
      parts.push({ type: 'image', mediaType: a.mediaType, data: a.data });
    } else if (a.kind === 'pdf' && a.data) {
      parts.push({ type: 'document', mediaType: 'application/pdf', data: a.data, name: a.name });
    } else if (a.kind === 'text' && a.text !== undefined) {
      parts.push({ type: 'text', text: `[Файл: ${a.name}]\n${a.text}` });
    }
  }
  parts.push({ type: 'text', text: text || '(см. вложения)' });
  return parts;
}

/** Ollama path: plain text + images array (llava/qwen-vl format). */
function toOllamaMessage(text: string, atts: CwmAttachment[]): { content: string; images?: string[] } {
  let content = text;
  const images: string[] = [];
  for (const a of atts) {
    if (a.kind === 'image' && a.data) images.push(a.data);
    else if (a.kind === 'text' && a.text !== undefined) content += `\n\n[Файл: ${a.name}]\n${a.text}`;
    else if (a.kind === 'pdf') content += `\n\n[Вложение ${a.name}: локальная модель не читает PDF — приложите текст или изображение]`;
  }
  return images.length > 0 ? { content, images } : { content };
}

export function useCwmChat() {
  const activeRequestId = useRef<string | null>(null);
  const activeChannel = useRef<'providers' | 'ollama' | null>(null);

  useEffect(() => {
    const handleChunk = (data: { requestId: string; chunk: string; type?: string; done: boolean; error?: string }) => {
      if (data.requestId !== activeRequestId.current) return;
      const s = useCwmStore.getState();
      const last = s.messages[s.messages.length - 1];
      if (!last || last.role !== 'assistant') return;
      if (data.chunk) {
        s.appendToMessage(last.id, data.chunk, data.type === 'thinking' ? 'thinking' : 'content');
      }
      if (data.done) {
        s.finishMessage(last.id, data.error);
        s.setStreaming(false);
        activeRequestId.current = null;
        activeChannel.current = null;
        s.persist().catch(() => {});
      }
    };

    const offProviders = window.api.providers.onChunk(handleChunk);
    const offOllama = window.api.ollama.onChunk(handleChunk as any);

    const offMedia = window.api.cwm.onMediaProgress((data) => {
      const s = useCwmStore.getState();
      s.updateGenJob(data.jobId, {
        status: data.status,
        percent: data.percent,
        filePath: data.filePath,
        fileName: data.fileName,
        mediaType: data.mediaType,
        base64: data.base64,
        error: data.error,
      });
      if (data.status === 'done' || data.status === 'failed' || data.status === 'cancelled') {
        s.persist().catch(() => {});
      }
    });

    return () => {
      offProviders();
      offOllama();
      offMedia();
    };
  }, []);

  async function send(text: string) {
    const s = useCwmStore.getState();
    const model = s.selectedModel;
    if (!model || s.isStreaming) return;
    const trimmed = text.trim();
    const atts = s.pendingAttachments;
    if (!trimmed && atts.length === 0) return;

    const userMsg: CwmMessage = {
      id: genId(),
      role: 'user',
      content: trimmed,
      attachments: atts.length > 0 ? atts : undefined,
      timestamp: Date.now(),
    };
    s.addMessage(userMsg);
    s.clearAttachments();

    const assistantMsg: CwmMessage = {
      id: genId(),
      role: 'assistant',
      content: '',
      thinking: '',
      model: model.displayName,
      timestamp: Date.now(),
      streaming: true,
    };
    s.addMessage(assistantMsg);
    s.setStreaming(true);

    const requestId = genId();
    activeRequestId.current = requestId;

    // History from the session: media-gen cards and errored turns excluded.
    const history = useCwmStore
      .getState()
      .messages.filter((m) => m.id !== assistantMsg.id && !m.gen && !m.error)
      .filter((m) => m.content.trim() || (m.attachments && m.attachments.length > 0));

    try {
      if (model.provider === 'ollama') {
        activeChannel.current = 'ollama';
        const messages = history.map((m) =>
          m.role === 'user'
            ? { role: m.role, ...toOllamaMessage(m.content, m.attachments || []) }
            : { role: m.role, content: m.content + attachmentNote([]) }
        );
        await window.api.ollama.chat({
          model: model.id,
          messages,
          system: CWM_SYSTEM_PROMPT,
          requestId,
        });
      } else {
        activeChannel.current = 'providers';
        const messages = history.map((m) =>
          m.role === 'user'
            ? { role: m.role, content: toParts(m.content, m.attachments || []) }
            : { role: m.role, content: m.content }
        );
        await window.api.providers.chat({
          providerId: model.provider,
          model: model.id,
          messages,
          system: CWM_SYSTEM_PROMPT,
          requestId,
        });
      }
    } catch (err: any) {
      const st = useCwmStore.getState();
      st.finishMessage(assistantMsg.id, String(err?.message || err));
      st.setStreaming(false);
      activeRequestId.current = null;
      activeChannel.current = null;
    }
  }

  function abort() {
    const id = activeRequestId.current;
    if (id) {
      if (activeChannel.current === 'ollama') window.api.ollama.abort(id);
      else window.api.providers.abort(id);
      activeRequestId.current = null;
      activeChannel.current = null;
    }
    useCwmStore.getState().setStreaming(false);
  }

  /** Insert a media-generation card and fire the job (image or video). */
  async function generateMedia(
    kind: 'image' | 'video',
    providerId: string,
    prompt: string
  ) {
    const s = useCwmStore.getState();
    const trimmed = prompt.trim();
    if (!trimmed) return;

    const jobId = genId();
    s.addMessage({
      id: genId(),
      role: 'user',
      content: kind === 'image' ? `🖼 Сгенерировать изображение: ${trimmed}` : `🎬 Сгенерировать видео: ${trimmed}`,
      timestamp: Date.now(),
    });
    s.addMessage({
      id: genId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      gen: { jobId, kind, status: 'queued', prompt: trimmed, providerId },
    });

    const call = kind === 'image' ? window.api.cwm.generateImage : window.api.cwm.generateVideo;
    // Result also arrives via cwm:media-progress; this await just surfaces
    // invoke-level failures (e.g. handler exceptions).
    call({ jobId, providerId, prompt: trimmed }).catch((err: any) => {
      useCwmStore.getState().updateGenJob(jobId, { status: 'failed', error: String(err?.message || err) });
    });
  }

  function cancelMedia(jobId: string) {
    window.api.cwm.cancelMedia(jobId).catch(() => {});
  }

  return { send, abort, generateMedia, cancelMedia };
}
