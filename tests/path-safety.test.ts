import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  isProtectedPath,
  isSafeExternalUrl,
  matchesAnyGlob,
  safeResolveInWorkspace,
} from '../electron/services/path-safety';
import { DEFAULT_PROTECTED_GLOBS } from '../electron/services/settings-schema';

const ROOT = path.resolve('/tmp/ws');

describe('safeResolveInWorkspace', () => {
  it('resolves relative paths inside the workspace', () => {
    const r = safeResolveInWorkspace('src/foo.ts', ROOT);
    expect(r.ok).toBe(true);
    expect(r.relative).toBe('src/foo.ts');
  });

  it('rejects path that escapes the workspace via ..', () => {
    const r = safeResolveInWorkspace('../etc/passwd', ROOT);
    expect(r.ok).toBe(false);
  });

  it('rejects absolute paths outside the workspace', () => {
    const r = safeResolveInWorkspace('/etc/passwd', ROOT);
    expect(r.ok).toBe(false);
  });

  it('rejects prefix collisions like /tmp/ws-other', () => {
    const r = safeResolveInWorkspace('/tmp/ws-other/x', ROOT);
    expect(r.ok).toBe(false);
  });

  it('rejects empty paths', () => {
    expect(safeResolveInWorkspace('', ROOT).ok).toBe(false);
    expect(safeResolveInWorkspace('   ', ROOT).ok).toBe(false);
  });

  it('rejects when no workspace is open', () => {
    expect(safeResolveInWorkspace('foo', null).ok).toBe(false);
  });

  it('strips quote wrappers', () => {
    const r = safeResolveInWorkspace('"src/foo.ts"', ROOT);
    expect(r.ok).toBe(true);
    expect(r.relative).toBe('src/foo.ts');
  });
});

describe('matchesAnyGlob', () => {
  it('matches simple ** patterns', () => {
    expect(matchesAnyGlob('foo/.env', ['**/.env'])).toBe(true);
    expect(matchesAnyGlob('.env', ['**/.env'])).toBe(true);
    expect(matchesAnyGlob('.env.local', ['.env.*'])).toBe(true);
  });

  it('does not over-match', () => {
    expect(matchesAnyGlob('readme.md', ['**/.env'])).toBe(false);
    expect(matchesAnyGlob('src/env.ts', ['.env'])).toBe(false);
  });

  it('handles *.pem', () => {
    expect(matchesAnyGlob('keys/foo.pem', ['**/*.pem'])).toBe(true);
    expect(matchesAnyGlob('foo.pem', ['**/*.pem'])).toBe(true);
  });
});

describe('isProtectedPath defaults', () => {
  it('protects .env at root and in subdirs', () => {
    expect(isProtectedPath('.env', DEFAULT_PROTECTED_GLOBS)).toBe(true);
    expect(isProtectedPath('apps/web/.env', DEFAULT_PROTECTED_GLOBS)).toBe(true);
    expect(isProtectedPath('.env.local', DEFAULT_PROTECTED_GLOBS)).toBe(true);
  });
  it('does not protect ordinary source files', () => {
    expect(isProtectedPath('src/App.tsx', DEFAULT_PROTECTED_GLOBS)).toBe(false);
    expect(isProtectedPath('package.json', DEFAULT_PROTECTED_GLOBS)).toBe(false);
  });
  it('protects keys and secrets', () => {
    expect(isProtectedPath('keys/id_rsa', DEFAULT_PROTECTED_GLOBS)).toBe(true);
    expect(isProtectedPath('cert/foo.pem', DEFAULT_PROTECTED_GLOBS)).toBe(true);
    expect(isProtectedPath('config/secrets.yaml', DEFAULT_PROTECTED_GLOBS)).toBe(true);
  });
});

describe('isSafeExternalUrl', () => {
  it('allows http/https/mailto', () => {
    expect(isSafeExternalUrl('https://ollama.com/download')).toBe(true);
    expect(isSafeExternalUrl('http://localhost:7860')).toBe(true);
    expect(isSafeExternalUrl('mailto:hi@example.com')).toBe(true);
  });

  it('blocks file: and local-program schemes', () => {
    expect(isSafeExternalUrl('file:///C:/Windows/System32/calc.exe')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeExternalUrl('ms-msdt:/id')).toBe(false);
    expect(isSafeExternalUrl('smb://attacker/share')).toBe(false);
  });

  it('rejects garbage and non-strings', () => {
    expect(isSafeExternalUrl('not a url')).toBe(false);
    expect(isSafeExternalUrl('')).toBe(false);
    expect(isSafeExternalUrl(null)).toBe(false);
    expect(isSafeExternalUrl(undefined)).toBe(false);
    expect(isSafeExternalUrl(42)).toBe(false);
  });
});
