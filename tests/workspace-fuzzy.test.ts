import { describe, expect, it } from 'vitest';
import { findClosestFragment, matchLineEndings } from '../electron/services/edit-fuzzy';

describe('findClosestFragment', () => {
  const file = [
    'function greet(name) {',
    '    return `hello ${name}`;',
    '}',
    '',
    'export const x = 1;',
  ].join('\n');

  it('recovers the exact fragment when only indentation differs', () => {
    // Model copied the body without the leading 4 spaces.
    const old = 'return `hello ${name}`;';
    const res = findClosestFragment(file, old);
    expect(res).not.toBeNull();
    // Exact bytes from the file, indentation preserved.
    expect(res!.fragment).toBe('    return `hello ${name}`;');
    expect(res!.startLine).toBe(2);
    expect(res!.endLine).toBe(2);
  });

  it('matches a multi-line block ignoring trailing whitespace and CRLF', () => {
    const crlf = file.replace(/\n/g, '\r\n');
    const old = 'function greet(name) {  \n    return `hello ${name}`;\n}';
    const res = findClosestFragment(crlf, old);
    expect(res).not.toBeNull();
    expect(res!.startLine).toBe(1);
    expect(res!.endLine).toBe(3);
    expect(res!.fragment.split('\n')[0]).toBe('function greet(name) {');
  });

  it('returns null when the fragment is genuinely absent', () => {
    expect(findClosestFragment(file, 'totally unrelated line')).toBeNull();
  });

  it('returns null when the trimmed match is ambiguous (not unique)', () => {
    const dup = ['a', 'dup', 'b', 'dup', 'c'].join('\n');
    expect(findClosestFragment(dup, 'dup')).toBeNull();
  });
});

describe('matchLineEndings', () => {
  const crlfFile = 'a\r\nb\r\nc\r\n';
  const lfFile = 'a\nb\nc\n';

  it('rewrites LF old_string to CRLF so it matches a CRLF file', () => {
    const old = 'a\nb';
    const fixed = matchLineEndings(old, crlfFile);
    expect(fixed).toBe('a\r\nb');
    expect(crlfFile.includes(fixed)).toBe(true);
  });

  it('rewrites CRLF old_string to LF so it matches an LF file', () => {
    const old = 'a\r\nb';
    expect(matchLineEndings(old, lfFile)).toBe('a\nb');
  });

  it('is a no-op when endings already match (CRLF)', () => {
    expect(matchLineEndings('a\r\nb', crlfFile)).toBe('a\r\nb');
  });

  it('strips stray CR the model added to a single line', () => {
    expect(matchLineEndings('x\r\n', lfFile)).toBe('x\n');
  });

  it('treats a file with no newline as LF', () => {
    expect(matchLineEndings('a\r\nb', 'single line')).toBe('a\nb');
  });
});
