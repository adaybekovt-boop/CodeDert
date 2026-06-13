import { describe, expect, it } from 'vitest';
import {
  FIELD_ALIASES,
  bareBodyArg,
  collapseOldToolResults,
  findCompletedToolCall,
  findSafeTextBoundary,
  looksLikeToolIntentWithoutCall,
  readField,
  readFieldAny,
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

  it('tolerates an unquoted name (weak-model output)', () => {
    const tc = findCompletedToolCall('<tool name=read_file>\n<path>a.ts</path>\n</tool>');
    expect(tc).not.toBeNull();
    expect(tc!.name).toBe('read_file');
    expect(readField(tc!.raw, 'path')).toBe('a.ts');
  });

  it('tolerates single quotes and spaces around =', () => {
    const tc = findCompletedToolCall("<tool name = 'list_dir'><path>src</path></tool>");
    expect(tc).not.toBeNull();
    expect(tc!.name).toBe('list_dir');
  });

  it('still does not confuse <tool_result> even with the lenient regex', () => {
    expect(
      findCompletedToolCall('<tool_result tool=read_file>x</tool_result>')
    ).toBeNull();
  });

  it('accepts the name-as-tag format <read_file>…</read_file>', () => {
    const tc = findCompletedToolCall('<read_file><path>a.ts</path></read_file>');
    expect(tc).not.toBeNull();
    expect(tc!.name).toBe('read_file');
    expect(readField(tc!.raw, 'path')).toBe('a.ts');
  });

  it('parses a name-as-tag edit_file with all fields', () => {
    const buf =
      '<edit_file><path>x.ts</path><old_string>a</old_string><new_string>b</new_string></edit_file>';
    const tc = findCompletedToolCall(buf);
    expect(tc).not.toBeNull();
    expect(tc!.name).toBe('edit_file');
    expect(readFieldAny(tc!.raw, FIELD_ALIASES.old_string)).toBe('a');
    expect(readFieldAny(tc!.raw, FIELD_ALIASES.new_string)).toBe('b');
  });

  it('accepts a name-as-tag tool with no body (mcp_list_tools)', () => {
    const tc = findCompletedToolCall('<mcp_list_tools></mcp_list_tools>');
    expect(tc).not.toBeNull();
    expect(tc!.name).toBe('mcp_list_tools');
  });

  it('returns the earliest complete block across both formats', () => {
    const buf = '<read_file><path>a</path></read_file> then <tool name="search"><query>x</query></tool>';
    const tc = findCompletedToolCall(buf);
    expect(tc!.name).toBe('read_file');
  });

  it('recognizes the ask tool in both formats with a question field', () => {
    const a = findCompletedToolCall('<tool name="ask"><question>Создать файл?</question></tool>');
    expect(a!.name).toBe('ask');
    expect(readFieldAny(a!.raw, FIELD_ALIASES.question)).toBe('Создать файл?');

    const b = findCompletedToolCall('<ask><prompt>Какой вариант?</prompt></ask>');
    expect(b!.name).toBe('ask');
    expect(readFieldAny(b!.raw, FIELD_ALIASES.question)).toBe('Какой вариант?');
  });
});

describe('readFieldAny (field-name synonyms)', () => {
  it('reads <old>/<new> as old_string/new_string', () => {
    const block = '<old>foo</old><new>bar</new>';
    expect(readFieldAny(block, FIELD_ALIASES.old_string)).toBe('foo');
    expect(readFieldAny(block, FIELD_ALIASES.new_string)).toBe('bar');
  });

  it('reads <file> as path', () => {
    expect(readFieldAny('<file>src/a.ts</file>', FIELD_ALIASES.path)).toBe('src/a.ts');
  });

  it('reads <text> as create_file content', () => {
    expect(readFieldAny('<text>hello</text>', FIELD_ALIASES.content)).toBe('hello');
  });

  it('returns null when no synonym is present', () => {
    expect(readFieldAny('<nope>x</nope>', FIELD_ALIASES.path)).toBeNull();
  });
});

describe('bareBodyArg (value directly in a name-as-tag body)', () => {
  it('reads the inner value of <read_file>config.json</read_file>', () => {
    expect(bareBodyArg('<read_file>config.json</read_file>')).toBe('config.json');
  });

  it('returns null for a structured block with child tags', () => {
    expect(
      bareBodyArg('<edit_file><path>x</path><old_string>a</old_string></edit_file>')
    ).toBeNull();
  });

  it('returns null for a canonical <tool name=...> block', () => {
    expect(bareBodyArg('<tool name="read_file"><path>x</path></tool>')).toBeNull();
  });

  it('trims and unescapes the body', () => {
    expect(bareBodyArg('<search>  a &amp; b  </search>')).toBe('a & b');
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
    expect(findSafeTextBoundary(buf, 0)).toBe(buf.length - 16);
  });

  it('holds back the unsafe tail while <tool may still be arriving', () => {
    const buf = 'обычный текст <to';
    expect(findSafeTextBoundary(buf, 0)).toBe(buf.length - 16);
  });

  it('hides text from a name-as-tag <edit_file> open', () => {
    const buf = 'Сейчас правлю.\n<edit_file><path>a.ts</path>';
    expect(findSafeTextBoundary(buf, 0)).toBe(buf.indexOf('<edit_file'));
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
