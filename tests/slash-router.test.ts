import { describe, expect, it } from 'vitest';
import { SLASH_COMMANDS, getSuggestions, parseSlashCommand } from '../src/lib/slash-router';

describe('parseSlashCommand', () => {
  it('returns null for non-slash text', () => {
    expect(parseSlashCommand('hello')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
  });

  it('parses /help', () => {
    const p = parseSlashCommand('/help');
    expect(p?.kind).toBe('help');
    expect(p?.command).toBe('/help');
  });

  it('parses /ultrathink:gemma <task>', () => {
    const p = parseSlashCommand('/ultrathink:gemma is the build broken');
    expect(p?.kind).toBe('ultrathink');
    expect(p?.variant).toBe('gemma');
    expect(p?.args).toBe('is the build broken');
  });

  it('parses /multyplan with multi-line args', () => {
    const p = parseSlashCommand('/multyplan add an auth flow\nwith oauth');
    expect(p?.kind).toBe('multyplan');
    expect(p?.args).toContain('oauth');
  });

  it('parses /multyplan approval helper commands', () => {
    expect(parseSlashCommand('/multyplan-approve')?.kind).toBe('multyplanApprove');
    expect(parseSlashCommand('/multyplan-reject')?.kind).toBe('multyplanReject');
  });

  it('parses /brain subcommands as brain command args', () => {
    const p = parseSlashCommand('/brain search sequential model execution');
    expect(p?.kind).toBe('brain');
    expect(p?.args).toBe('search sequential model execution');
  });

  it('returns kind=ask for unknown slashes (fallback)', () => {
    const p = parseSlashCommand('/whatever xyz');
    expect(p).not.toBeNull();
    expect(p?.kind).toBe('ask');
  });

  it('parses /stop with no args', () => {
    expect(parseSlashCommand('/stop')?.kind).toBe('stop');
  });
});

describe('getSuggestions', () => {
  it('returns matches for prefixes', () => {
    const s = getSuggestions('/m');
    const names = s.map((c) => c.name);
    expect(names).toContain('/multyplan');
    expect(names).toContain('/models');
    expect(names).toContain('/model');
  });
  it('returns empty for non-slash input', () => {
    expect(getSuggestions('hello').length).toBe(0);
  });
});

describe('SLASH_COMMANDS coverage', () => {
  it('includes all required commands', () => {
    const required = [
      '/help',
      '/ask',
      '/edit',
      '/fix',
      '/review',
      '/explain',
      '/test',
      '/commit',
      '/plan',
      '/multyplan',
      '/ultrathink',
      '/brain',
      '/settings',
      '/models',
      '/stop',
      '/clear',
      '/index',
    ];
    const names = new Set(SLASH_COMMANDS.map((c) => c.name));
    for (const r of required) expect(names.has(r)).toBe(true);
  });
});
