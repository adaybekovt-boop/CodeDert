import { describe, expect, it } from 'vitest';
import {
  collapseOldToolResults,
  findCompletedToolCall,
  findSafeTextBoundary,
  looksLikeToolIntentWithoutCall,
  readField,
  type AgentMessage,
} from '../electron/services/agent-protocol';

describe('findCompletedToolCall', () => {
  it('parses a complete tool block', () => {
    const buf = 'Сейчас прочитаю.\n<tool name="read_file">\n<path>lib/main.dart</path>\n</tool>';
    const tc = findCompletedToolCall(buf);
    expect(tc).not.toBeNull();
    expect(tc!.name).toBe('read_file');
    expect(readField(tc!.raw, 'path')).toBe('lib/main.dart');
    expect(buf.slice(tc!.startInOutput, tc!.endInOutput)).toBe(tc!.raw);
  });

  it('returns null while the block is still streaming', () => {
    expect(findCompletedToolCall('<tool name="read_file">\n<path>a.ts</path>')).toBeNull();
  });

  it('does not treat <tool_result> as a tool call', () => {
    expect(
      findCompletedToolCall('<tool_result tool="read_file">данные</tool_result>')
    ).toBeNull();
  });
});

describe('looksLikeToolIntentWithoutCall', () => {
  it('detects the classic "сначала прочитаю" stall', () => {
    expect(looksLikeToolIntentWithoutCall('Сначала прочитаю README.md')).toBe(true);
  });

  it('detects a named tool promised in prose (create_file case)', () => {
    expect(
      looksLikeToolIntentWithoutCall(
        'Создам файл docs/report.md с кратким отчетом, использую create_file.'
      )
    ).toBe(true);
  });

  it('detects an english-style promise', () => {
    expect(looksLikeToolIntentWithoutCall("Let me use read_file to check lib/main.dart")).toBe(
      true
    );
  });

  it('detects a fabricated <tool_result>', () => {
    expect(
      looksLikeToolIntentWithoutCall('<tool_result tool="search">3 совпадения</tool_result>\nГотово.')
    ).toBe(true);
  });

  it('is false when a real tool block is present', () => {
    expect(
      looksLikeToolIntentWithoutCall(
        'Сначала прочитаю README.md\n<tool name="read_file">\n<path>README.md</path>\n</tool>'
      )
    ).toBe(false);
  });

  it('is false for a plain final answer', () => {
    expect(
      looksLikeToolIntentWithoutCall(
        'Точка входа проекта — lib/main.dart: там вызывается runApp с виджетом App.'
      )
    ).toBe(false);
  });

  it('is false for a past-tense summary that mentions what was done', () => {
    expect(
      looksLikeToolIntentWithoutCall(
        'Готово: я заменил mock-status на ok-status в api_client.dart и проверил, что других вхождений нет.'
      )
    ).toBe(false);
  });
});

describe('findSafeTextBoundary', () => {
  it('hides text from a real opening <tool tag', () => {
    const buf = 'Читаю файл.\n<tool name="read_file">';
    expect(findSafeTextBoundary(buf, 0)).toBe(buf.indexOf('<tool'));
  });

  it('does NOT freeze the stream on an echoed <tool_result', () => {
    const buf = '<tool_result tool="read_file">данные</tool_result> и дальше текст идёт';
    // Boundary must keep advancing (only the small trailing hold-back remains).
    expect(findSafeTextBoundary(buf, 0)).toBe(buf.length - 6);
  });

  it('holds back the unsafe tail while <tool may still be arriving', () => {
    const buf = 'обычный текст <to';
    expect(findSafeTextBoundary(buf, 0)).toBe(buf.length - 6);
  });
});

describe('collapseOldToolResults', () => {
  function assistant(content: string): AgentMessage {
    return { role: 'assistant', content };
  }

  it('collapses big tool_result bodies in old assistant turns only', () => {
    const big = `<tool_result tool="read_file">\n${'x'.repeat(2000)}\n</tool_result>`;
    const convo: AgentMessage[] = [
      { role: 'system', content: 'sys' },
      assistant(big),
      { role: 'user', content: 'next' },
      assistant(big),
      { role: 'user', content: 'next' },
      assistant(big),
    ];
    collapseOldToolResults(convo, 2);
    expect(convo[1].content).toContain('свёрнуто для экономии токенов');
    expect(convo[3].content).toBe(big);
    expect(convo[5].content).toBe(big);
  });

  it('keeps small tool_results intact', () => {
    const small = '<tool_result tool="edit_file">OK</tool_result>';
    const convo: AgentMessage[] = [
      assistant(small),
      { role: 'user', content: 'a' },
      assistant(small),
      { role: 'user', content: 'b' },
      assistant(small),
    ];
    collapseOldToolResults(convo, 2);
    expect(convo[0].content).toBe(small);
  });
});
