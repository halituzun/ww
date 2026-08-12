import { describe, expect, it } from 'vitest';
import {
  fromAnthropicContent,
  fromOpenAiToolCalls,
  toAnthropicMessages,
  toAnthropicTools,
  toOpenAiMessages,
  toOpenAiTools,
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

  it('yanıttaki tool_calls normalize edilir; bozuk JSON boş argüman olur', () => {
    const calls = fromOpenAiToolCalls([
      { id: 'x', function: { name: 'read_file', arguments: '{"path":"b.ts"}' } },
      { id: 'y', function: { name: 'read_file', arguments: '{bozuk' } },
    ]);
    expect(calls[0]!.args).toEqual({ path: 'b.ts' });
    expect(calls[1]!.args).toEqual({});
    expect(fromOpenAiToolCalls(undefined)).toEqual([]);
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
});
