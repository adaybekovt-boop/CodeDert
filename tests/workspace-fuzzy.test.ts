import { describe, expect, it } from 'vitest';
import { findClosestFragment } from '../electron/services/edit-fuzzy';

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
