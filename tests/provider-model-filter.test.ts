import { describe, expect, it } from 'vitest';
import { isChatCompletionModel } from '../electron/services/provider-model-filter';

describe('provider chat model filter', () => {
  it('keeps regular chat models', () => {
    expect(isChatCompletionModel('xai', 'grok-4')).toBe(true);
    expect(isChatCompletionModel('xai', 'grok-code-fast-1')).toBe(true);
    expect(isChatCompletionModel('openai', 'gpt-4.1')).toBe(true);
    expect(isChatCompletionModel('anthropic', 'claude-sonnet-4-5')).toBe(true);
  });

  it('filters media and non-chat models by id', () => {
    expect(isChatCompletionModel('xai', 'grok-imagine-image')).toBe(false);
    expect(isChatCompletionModel('xai', 'grok-imagine-video')).toBe(false);
    expect(isChatCompletionModel('openai', 'gpt-image-1')).toBe(false);
    expect(isChatCompletionModel('openai', 'sora-2')).toBe(false);
    expect(isChatCompletionModel('openai', 'text-embedding-3-large')).toBe(false);
    expect(isChatCompletionModel('openai', 'gpt-4o-realtime-preview')).toBe(false);
  });

  it('filters models whose declared output modality is not text', () => {
    expect(
      isChatCompletionModel('openrouter', {
        id: 'provider/media-model',
        architecture: { output_modalities: ['image'] },
      })
    ).toBe(false);
    expect(
      isChatCompletionModel('openrouter', {
        id: 'provider/vision-chat',
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      })
    ).toBe(true);
  });
});

