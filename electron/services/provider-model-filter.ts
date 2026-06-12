export interface RawProviderModel {
  id?: unknown;
  name?: unknown;
  display_name?: unknown;
  displayName?: unknown;
  type?: unknown;
  modality?: unknown;
  modalities?: unknown;
  input_modalities?: unknown;
  output_modalities?: unknown;
  architecture?: {
    modality?: unknown;
    input_modalities?: unknown;
    output_modalities?: unknown;
  };
}

const NON_CHAT_ID_RE =
  /(^|[-_/])(dall-e|gpt-image|image|images|imagine|imagen|video|videos|sora|tts|whisper|audio|speech|transcribe|transcription|embedding|embeddings|embed|rerank|moderation|realtime|deep-research|multi-agent)([-_/:.]|$)/i;

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return [value];
  return [];
}

function includesText(values: string[]): boolean {
  return values.some((v) => /\btext\b/i.test(v));
}

function includesNonChatOnly(values: string[]): boolean {
  return values.some((v) => /\b(image|video|audio|embedding|moderation|rerank)\b/i.test(v));
}

export function isChatCompletionModel(providerId: string, model: RawProviderModel | string): boolean {
  const raw: RawProviderModel = typeof model === 'string' ? { id: model } : model || {};
  const id = String(raw.id || raw.name || '').trim();
  if (!id) return false;

  const nameText = [
    id,
    typeof raw.displayName === 'string' ? raw.displayName : '',
    typeof raw.display_name === 'string' ? raw.display_name : '',
  ].join(' ');

  if (providerId === 'xai' && /^grok-imagine/i.test(id)) return false;
  if (NON_CHAT_ID_RE.test(nameText)) return false;

  const outputModalities = [
    ...asList(raw.output_modalities),
    ...asList(raw.architecture?.output_modalities),
  ];
  if (outputModalities.length > 0 && !includesText(outputModalities)) return false;

  const declaredModalities = [
    ...asList(raw.type),
    ...asList(raw.modality),
    ...asList(raw.modalities),
    ...asList(raw.input_modalities),
    ...asList(raw.architecture?.modality),
    ...asList(raw.architecture?.input_modalities),
  ];
  if (declaredModalities.length > 0 && includesNonChatOnly(declaredModalities) && !includesText(declaredModalities)) {
    return false;
  }

  return true;
}

