import { describe, expect, it } from 'vitest';
import { validateUltrathinkReport, ULTRATHINK_REQUIRED_SECTIONS } from '../electron/services/ultrathink-validator';

const skeleton = ULTRATHINK_REQUIRED_SECTIONS.map((s, i) => `## ${s}\n- src/app.ts: example evidence`).join('\n\n');

describe('validateUltrathinkReport', () => {
  it('rejects an empty report', () => {
    const r = validateUltrathinkReport('', 0.5);
    expect(r.ok).toBe(false);
    expect(r.issues).toContain('empty output');
  });

  it('flags missing sections', () => {
    const r = validateUltrathinkReport('## Short Answer\nyes', 0.5);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.startsWith('missing section'))).toBe(true);
  });

  it('extracts a percent-based confidence', () => {
    const report = `${skeleton}\n\n## Confidence Level\n80%\n\nsrc/app.ts: more evidence\n## Detailed Implementation Plan\n- step 1`;
    const r = validateUltrathinkReport(report, 0.5);
    expect(r.confidence).toBeCloseTo(0.8, 2);
  });

  it('fails confidence below threshold', () => {
    const report = `${skeleton}\n\n## Confidence Level\n10%\n\nsrc/app.ts: more evidence\n## Detailed Implementation Plan\n- step 1`;
    const r = validateUltrathinkReport(report, 0.5);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.startsWith('confidence below'))).toBe(true);
  });
});
