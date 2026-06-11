// Chat With Model (CWM) — renderer types.
// CWM is the conversational mode: no agent tools, no workspace access.

export type CwmComposerMode = 'chat' | 'image' | 'video';

export type CwmAttachmentKind = 'image' | 'pdf' | 'text';

export interface CwmAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  kind: CwmAttachmentKind;
  /** Base64 payload (images/pdf), without the data: prefix. */
  data?: string;
  /** Extracted text for text-like files. */
  text?: string;
}

export type CwmJobStatus = 'queued' | 'generating' | 'done' | 'failed' | 'cancelled';

export interface CwmGenJob {
  jobId: string;
  kind: 'image' | 'video';
  status: CwmJobStatus;
  prompt: string;
  providerId: string;
  percent?: number;
  filePath?: string;
  fileName?: string;
  mediaType?: string;
  /** Inline preview for images. Videos are read back via cwm.readMedia. */
  base64?: string;
  error?: string;
}

export interface CwmMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  attachments?: CwmAttachment[];
  /** Set on assistant messages that are media-generation cards. */
  gen?: CwmGenJob;
  model?: string;
  timestamp: number;
  streaming?: boolean;
  error?: string;
}

export interface CwmSessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  model?: string;
}

// ── Attachment validation limits ─────────────────────────────

export const CWM_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const CWM_MAX_IMAGE_BYTES = 5 * 1024 * 1024; // common provider limit
export const CWM_MAX_PDF_BYTES = 10 * 1024 * 1024;
export const CWM_MAX_TEXT_BYTES = 256 * 1024;
export const CWM_MAX_ATTACHMENTS = 8;

const TEXT_EXTENSIONS = /\.(txt|md|markdown|json|csv|tsv|xml|yaml|yml|toml|ini|log|ts|tsx|js|jsx|py|rb|go|rs|java|c|h|cpp|hpp|cs|php|swift|kt|sql|sh|bat|html|css|scss)$/i;

export function classifyAttachment(name: string, mediaType: string): CwmAttachmentKind | null {
  if (CWM_IMAGE_TYPES.has(mediaType)) return 'image';
  if (mediaType === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (mediaType.startsWith('text/') || TEXT_EXTENSIONS.test(name)) return 'text';
  return null;
}

export function validateAttachment(
  kind: CwmAttachmentKind,
  size: number
): { ok: boolean; error?: string } {
  if (kind === 'image' && size > CWM_MAX_IMAGE_BYTES)
    return { ok: false, error: `изображение больше ${CWM_MAX_IMAGE_BYTES / 1024 / 1024} МБ` };
  if (kind === 'pdf' && size > CWM_MAX_PDF_BYTES)
    return { ok: false, error: `PDF больше ${CWM_MAX_PDF_BYTES / 1024 / 1024} МБ` };
  if (kind === 'text' && size > CWM_MAX_TEXT_BYTES)
    return { ok: false, error: `текстовый файл больше ${CWM_MAX_TEXT_BYTES / 1024} КБ` };
  return { ok: true };
}
