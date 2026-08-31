import { describe, expect, it } from 'vitest';
import { PromptMessageV1Schema } from '@ww/shared';
import {
  fromAnthropicContent,
  fromOpenAiToolCalls,
  toAnthropicMessages,
  toAnthropicTools,
  toOpenAiMessages,
  toOpenAiTools,
  toPromptToolCallV1,
} from './normalize.js';
import type { ChatMessage, ToolDef } from '../types.js';

const TOOL: ToolDef = {
  name: 'write_file',
  description: 'dosya yazar',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

const CONVO: ChatMessage[] = [
  { role: 'system', content: 'sen bir worker agentsın' },
  { role: 'user', content: 'a.ts dosyasını oluştur' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'a.ts' } }] },
  { role: 'tool', content: 'yazıldı', toolCallId: 'c1' },
];

describe('OpenAI normalizasyonu', () => {
  it('provider ChatMessage tipi shared runtime prompt sözleşmesiyle hizalıdır', () => {
    for (const message of CONVO) {
      expect(PromptMessageV1Schema.safeParse(message).success).toBe(true);
    }
  });

  it('mesajları çevirir; tool çağrısı JSON string argümanına döner', () => {
    const out = toOpenAiMessages(CONVO);
    expect(out[0]).toEqual({ role: 'system', content: 'sen bir worker agentsın' });
    expect(out[2]!.tool_calls![0]!.function).toEqual({ name: 'write_file', arguments: '{"path":"a.ts"}' });
    expect(out[3]).toEqual({ role: 'tool', content: 'yazıldı', tool_call_id: 'c1' });
  });

  it('araçları function biçimine sarar', () => {
    expect(toOpenAiTools([TOOL])![0]).toEqual({
      type: 'function',
      function: { name: 'write_file', description: 'dosya yazar', parameters: TOOL.parameters },
    });
    expect(toOpenAiTools([])).toBeUndefined();
  });

  it('yanıttaki tool_calls kayıpsız normalize edilir; bozuk JSON untrusted kalır', () => {
    const calls = fromOpenAiToolCalls([
      { id: 'x', function: { name: 'read_file', arguments: '{"path":"b.ts"}' } },
      { id: 'y', function: { name: 'read_file', arguments: '{bozuk' } },
    ]);
    expect(calls[0]!.args).toEqual({ path: 'b.ts' });
    expect(calls[1]!.args).toBe('{bozuk');
    expect(fromOpenAiToolCalls(undefined)).toEqual([]);
  });

  it('Phase 7 handoff yalnız strict PromptToolCallV1 doğrulamasından sonra yapılır', () => {
    const normalized = fromOpenAiToolCalls([
      { id: 'x', function: { name: 'read_file', arguments: '{"path":"b.ts"}' } },
    ])[0]!;

    const promptToolCall = toPromptToolCallV1(normalized);
    expect(promptToolCall).toEqual({ id: 'x', name: 'read_file', args: { path: 'b.ts' } });
    expect(promptToolCall).not.toBe(normalized);
    expect(Object.isFrozen(promptToolCall)).toBe(true);
    expect(Object.isFrozen(promptToolCall.args)).toBe(true);
  });

  it('malformed ve non-JSON tool argümanlarını fail-closed reddeder', () => {
    const malformed = fromOpenAiToolCalls([
      { id: 'x', function: { name: 'read_file', arguments: '{bozuk' } },
    ])[0]!;
    const invalidArgs: unknown[] = [
      malformed.args,
      undefined,
      null,
      ['b.ts'],
      Number.POSITIVE_INFINITY,
      new Date('2026-08-14T08:00:00.000Z'),
      { path: undefined },
      JSON.parse('{"__proto__":{"polluted":true}}'),
    ];

    for (const args of invalidArgs) {
      expect(() => toPromptToolCallV1({ id: 'x', name: 'read_file', args })).toThrow();
    }
    expect(malformed.args).toBe('{bozuk');
  });
});

describe('Anthropic normalizasyonu', () => {
  it('system ayrılır, tool_result user bloğuna çevrilir', () => {
    const { system, messages } = toAnthropicMessages(CONVO);
    expect(system).toBe('sen bir worker agentsın');
    expect(messages).toHaveLength(3);
    expect(messages[1]!.role).toBe('assistant');
    expect((messages[1]!.content as { type: string }[])[0]).toMatchObject({ type: 'tool_use', name: 'write_file' });
    expect((messages[2]!.content as { type: string }[])[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1' });
  });

  it('araçlar input_schema biçimine döner', () => {
    expect(toAnthropicTools([TOOL])![0]).toEqual({
      name: 'write_file',
      description: 'dosya yazar',
      input_schema: TOOL.parameters,
    });
  });

  it('yanıt blokları metin + tool çağrısına ayrışır', () => {
    const r = fromAnthropicContent([
      { type: 'text', text: 'tamam, ' },
      { type: 'text', text: 'yazıyorum' },
      { type: 'tool_use', id: 'c9', name: 'write_file', input: { path: 'c.ts' } },
    ]);
    expect(r.content).toBe('tamam, yazıyorum');
    expect(r.toolCalls).toEqual([{ id: 'c9', name: 'write_file', args: { path: 'c.ts' } }]);
    expect(fromAnthropicContent([{ type: 'tool_use', id: 'z', name: 'x', input: {} }]).content).toBeNull();
  });

  it('eksik Anthropic input değerini boş nesneye dönüştürmez', () => {
    const call = fromAnthropicContent([{ type: 'tool_use', id: 'z', name: 'x' }]).toolCalls[0]!;
    expect(call.args).toBeUndefined();
    expect(() => toPromptToolCallV1(call)).toThrow();
  });
});
