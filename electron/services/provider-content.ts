/**
 * Multimodal content packing — pure functions, no electron imports
 * (also unit-tested directly in tests/cwm.test.ts).
 *
 * Vision formats differ per provider family: Anthropic takes base64 source
 * blocks, OpenAI-compatible APIs take data-URL image_url parts. Never assume
 * one format fits all.
 */

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string } // base64, no data: prefix
  | { type: 'document'; mediaType: string; data: string; name?: string }; // PDF

export interface ChatMessageIn {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

/** Anthropic Messages API content blocks. */
export function packAnthropicContent(content: string | ContentPart[]): unknown {
  if (typeof content === 'string') return content;
  return content.map((p) => {
    if (p.type === 'text') return { type: 'text', text: p.text };
    if (p.type === 'image') {
      return { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } };
    }
    return { type: 'document', source: { type: 'base64', media_type: p.mediaType, data: p.data } };
  });
}

/** OpenAI-compatible content parts. Throws for parts the format can't carry. */
export function packOpenAiContent(content: string | ContentPart[]): unknown {
  if (typeof content === 'string') return content;
  return content.map((p) => {
    if (p.type === 'text') return { type: 'text', text: p.text };
    if (p.type === 'image') {
      return { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } };
    }
    throw new Error(
      `вложение «${p.name || 'документ'}»: этот провайдер не принимает PDF напрямую — используйте Anthropic или приложите изображение/текст`
    );
  });
}

export function hasAttachmentParts(messages: ChatMessageIn[]): boolean {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type !== 'text'));
}
