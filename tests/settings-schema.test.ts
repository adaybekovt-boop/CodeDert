import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
} from '../electron/services/settings-schema';

describe('normalizeAppSettings', () => {
  it('returns defaults for empty input', () => {
    const s = normalizeAppSettings(undefined);
    expect(s.provider.ollama.baseUrl).toBe(DEFAULT_APP_SETTINGS.provider.ollama.baseUrl);
    expect(s.sequentialLocalModels).toBe(true);
    expect(s.allowDestructiveTerminal).toBe(false);
  });

  it('forces safety invariants regardless of input', () => {
    const s = normalizeAppSettings({
      sequentialLocalModels: false,
      allowDestructiveTerminal: true,
    } as any);
    expect(s.sequentialLocalModels).toBe(true);
    expect(s.allowDestructiveTerminal).toBe(false);
  });

  it('defaults autoStart for Ollama to true', () => {
    const s = normalizeAppSettings(undefined);
    expect(s.provider.ollama.autoStart).toBe(true);
  });

  it('preserves autoStart=false when explicitly disabled', () => {
    const s = normalizeAppSettings({
      provider: { ollama: { baseUrl: 'http://localhost:11434', autoStart: false } },
    } as any);
    expect(s.provider.ollama.autoStart).toBe(false);
  });

  it('clamps tuning into valid ranges', () => {
    const s = normalizeAppSettings({
      tuning: { temperature: 99, maxOutputTokens: -10, contextWindow: 999_999_999, keepAliveSeconds: 999_999 },
    } as any);
    expect(s.tuning.temperature).toBeLessThanOrEqual(2);
    expect(s.tuning.maxOutputTokens).toBeGreaterThanOrEqual(64);
    expect(s.tuning.contextWindow).toBeLessThanOrEqual(200_000);
    expect(s.tuning.keepAliveSeconds).toBeLessThanOrEqual(3600);
  });

  it('keeps protected globs as-is when valid; falls back when empty', () => {
    const s1 = normalizeAppSettings({ agent: { protectedGlobs: ['**/secret.txt'] } } as any);
    expect(s1.agent.protectedGlobs).toEqual(['**/secret.txt']);
    const s2 = normalizeAppSettings({ agent: { protectedGlobs: [] } } as any);
    expect(s2.agent.protectedGlobs.length).toBeGreaterThan(0);
  });

  it('clamps performance limits', () => {
    const s = normalizeAppSettings({
      performance: {
        streamThrottleMs: 10_000,
        maxChatHistory: 0,
        maxRenderedMessages: 0,
        maxContextBytes: -100,
        scanConcurrency: 9999,
      },
    } as any);
    expect(s.performance.streamThrottleMs).toBeLessThanOrEqual(1000);
    expect(s.performance.maxChatHistory).toBeGreaterThanOrEqual(10);
    expect(s.performance.scanConcurrency).toBeLessThanOrEqual(32);
  });
});
