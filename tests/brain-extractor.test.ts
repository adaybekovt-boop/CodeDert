import { describe, expect, it } from 'vitest';
import { extractCandidates, titleSimilarity } from '../electron/services/brain-extractor';

describe('extractCandidates — explicit markers', () => {
  it('captures TODO lines as task', () => {
    const out = extractCandidates({
      user: 'TODO: refactor the workspace scanner to use concurrency',
      assistant: '',
    });
    expect(out.find((c) => c.type === 'task')).toBeTruthy();
  });

  it('captures IMPORTANT lines as warning', () => {
    const out = extractCandidates({
      user: '',
      assistant: 'IMPORTANT: do not run rm -rf in the workspace root',
    });
    expect(out.find((c) => c.type === 'warning')).toBeTruthy();
  });

  it('captures explicit decisions', () => {
    const out = extractCandidates({
      user: '',
      assistant: "we'll use Zustand for state management going forward",
    });
    expect(out.find((c) => c.type === 'decision')).toBeTruthy();
  });

  it('captures preference lines as workflow', () => {
    const out = extractCandidates({
      user: 'I prefer tabs over spaces',
      assistant: '',
    });
    expect(out.find((c) => c.type === 'workflow')).toBeTruthy();
  });

  it('captures architecture statements', () => {
    const out = extractCandidates({
      user: '',
      assistant: 'The Brain service uses electron-store for persistence.',
    });
    expect(out.find((c) => c.type === 'architecture')).toBeTruthy();
  });

  it('captures code blocks as code_pattern', () => {
    const code = '```ts\nexport function add(a: number, b: number) {\n  return a + b;\n}\nadd(1, 2);\nadd(2, 3);\nadd(3, 4);\n```';
    const out = extractCandidates({ user: '', assistant: code });
    const codeCandidate = out.find((c) => c.type === 'code_pattern');
    expect(codeCandidate).toBeTruthy();
    expect(codeCandidate!.tags).toContain('code');
  });
});

describe('extractCandidates — safety', () => {
  it('skips messages containing secrets entirely', () => {
    const out = extractCandidates({
      user: 'TODO: store sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII somewhere',
      assistant: '',
    });
    // Whole message is rejected because of the secret content.
    expect(out.length).toBe(0);
  });

  it('skips short prose', () => {
    const out = extractCandidates({ user: 'ok', assistant: 'ok' });
    expect(out.length).toBe(0);
  });

  it('does not duplicate the same rule on a single line', () => {
    const out = extractCandidates({
      user: 'TODO: never delete this file',
      assistant: '',
    });
    // Matches a `task` (TODO:) rule first; the `warning` rule is not added
    // because of the per-line `break`.
    expect(out.filter((c) => c.title.includes('never delete')).length).toBeLessThanOrEqual(1);
  });
});

describe('titleSimilarity', () => {
  it('returns 1 for identical titles', () => {
    expect(titleSimilarity('foo bar baz', 'foo bar baz')).toBe(1);
  });

  it('is high for paraphrases', () => {
    expect(titleSimilarity('refactor workspace scanner', 'refactor the workspace scanner')).toBeGreaterThan(0.6);
  });

  it('is low for unrelated titles', () => {
    expect(titleSimilarity('refactor scanner', 'investigate VRAM leak')).toBeLessThan(0.2);
  });
});
