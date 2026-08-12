// İç format ↔ sağlayıcı formatı çevirileri (docs/04-model-katmani.md → tool-use normalizasyonu).
// Saf fonksiyonlar: SDK'ya bağımlı değildir, birim testlerle doğrulanır.
import type { ChatMessage, NormalizedToolCall, ToolDef } from '../types.js';

/* ---------------------------------- OpenAI --------------------------------- */

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
}

export function toOpenAiMessages(messages: ChatMessage[]): OpenAiMessage[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '' };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

export function toOpenAiTools(tools: ToolDef[] | undefined) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function fromOpenAiToolCalls(
  calls: { id: string; function: { name: string; arguments: string } }[] | undefined,
): NormalizedToolCall[] {
  if (!calls?.length) return [];
  return calls.map((c) => ({
    id: c.id,
    name: c.function.name,
    args: parseArgs(c.function.arguments),
  }));
}

/* --------------------------------- Anthropic -------------------------------- */

export interface AnthropicBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

// Anthropic'te system ayrı parametredir; birden çok system mesajı birleştirilir.
export function toAnthropicMessages(messages: ChatMessage[]): {
  system: string | undefined;
  messages: AnthropicMessage[];
} {
  const systems: string[] = [];
  const out: AnthropicMessage[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      systems.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content }],
      });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const blocks: AnthropicBlock[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }

  return { system: systems.length ? systems.join('\n\n') : undefined, messages: out };
}

export function toAnthropicTools(tools: ToolDef[] | undefined) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

export function fromAnthropicContent(blocks: AnthropicBlock[]): {
  content: string | null;
  toolCalls: NormalizedToolCall[];
} {
  const texts: string[] = [];
  const toolCalls: NormalizedToolCall[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && b.text) texts.push(b.text);
    if (b.type === 'tool_use') {
      toolCalls.push({ id: b.id ?? '', name: b.name ?? '', args: b.input ?? {} });
    }
  }
  return { content: texts.length ? texts.join('') : null, toolCalls };
}

/* ---------------------------------- ortak ---------------------------------- */

// Modeller bazen bozuk JSON üretir; çağrıyı düşürmek yerine boş argümanla devam et.
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw || '{}');
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
