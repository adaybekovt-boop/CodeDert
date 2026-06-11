import { describe, expect, it } from 'vitest';
import {
  packAnthropicContent,
  packOpenAiContent,
  type ContentPart,
} from '../electron/services/provider-content';
import {
  classifyAttachment,
  validateAttachment,
  CWM_MAX_IMAGE_BYTES,
} from '../src/lib/cwm-types';

describe('CWM multimodal content packing', () => {
  const parts: ContentPart[] = [
    { type: 'text', text: 'что на фото?' },
    { type: 'image', mediaType: 'image/png', data: 'AAAA' },
  ];

  it('keeps plain-string content untouched for both kinds', () => {
    expect(packAnthropicContent('привет')).toBe('привет');
    expect(packOpenAiContent('привет')).toBe('привет');
  });

  it('packs images into Anthropic base64 source blocks', () => {
    expect(packAnthropicContent(parts)).toEqual([
      { type: 'text', text: 'что на фото?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
  });

  it('packs images into OpenAI-compatible data-URL image_url parts', () => {
    expect(packOpenAiContent(parts)).toEqual([
      { type: 'text', text: 'что на фото?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });

  it('packs PDFs as Anthropic document blocks', () => {
    const pdf: ContentPart[] = [{ type: 'document', mediaType: 'application/pdf', data: 'BBBB', name: 'a.pdf' }];
    expect(packAnthropicContent(pdf)).toEqual([
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'BBBB' } },
    ]);
  });

  it('rejects PDFs for OpenAI-compatible providers with a readable error', () => {
    const pdf: ContentPart[] = [{ type: 'document', mediaType: 'application/pdf', data: 'BBBB', name: 'a.pdf' }];
    expect(() => packOpenAiContent(pdf)).toThrowError(/a\.pdf/);
  });
});

describe('CWM attachment validation', () => {
  it('classifies by media type and extension', () => {
    expect(classifyAttachment('a.png', 'image/png')).toBe('image');
    expect(classifyAttachment('doc.pdf', 'application/pdf')).toBe('pdf');
    expect(classifyAttachment('doc.pdf', '')).toBe('pdf');
    expect(classifyAttachment('notes.md', '')).toBe('text');
    expect(classifyAttachment('код.ts', '')).toBe('text');
    expect(classifyAttachment('archive.zip', 'application/zip')).toBeNull();
    expect(classifyAttachment('movie.mp4', 'video/mp4')).toBeNull();
  });

  it('enforces size limits per kind', () => {
    expect(validateAttachment('image', CWM_MAX_IMAGE_BYTES).ok).toBe(true);
    expect(validateAttachment('image', CWM_MAX_IMAGE_BYTES + 1).ok).toBe(false);
    expect(validateAttachment('text', 1024).ok).toBe(true);
    expect(validateAttachment('text', 10 * 1024 * 1024).ok).toBe(false);
  });
});
