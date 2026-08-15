import { describe, expect, it } from 'vitest';
import { MockProvider } from '@ww/providers';
import { ModelRouter } from '@ww/providers';
import { runWorkerLoop } from './worker-loop.js';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const brief = { projectId: id(1), taskId: id(2), taskBriefId: id(3), allowedTools: ['ask_question', 'read_file', 'report_result'], deadlineAt: '2030-01-01T00:00:00.000Z' } as never;
const attempt = { assignmentAttemptId: id(4), workerAgentId: id(5) } as never;
const snapshot = { invocationId: id(6), promptInputSnapshotId: id(7) } as never;
function router(provider: MockProvider): ModelRouter { return new ModelRouter(new Map([['mock', provider]]), { fallbacks: () => [], usageSink: async () => undefined, invocationEffect: { run: async ({ execute }) => execute() } }); }

describe('worker loop', () => {
  it('soruyu iletişim portuna bağlayıp message id ile durur', async () => {
    const provider = new MockProvider({ script: [{ content: null, toolCalls: [{ id: id(8), name: 'ask_question', args: { content: 'hangi klasör?' } }] }] });
    const questions: unknown[] = [];
    const result = await runWorkerLoop({ brief, attempt, snapshot, modelRef: 'mock:mock-model', router: router(provider), prompt: [{ role: 'user', content: 'iş' }], tools: { definitions: () => [{ name: 'ask_question', description: '', parameters: {} }], validate: (_name, args) => args, execute: async () => ({}) }, communication: { question: async (input) => { questions.push(input); return { messageId: id(9) }; }, report: async () => undefined } });
    expect(result).toMatchObject({ reason: 'question', questionMessageId: id(9), question: 'hangi klasör?' });
    expect(questions[0]).toMatchObject({ projectId: id(1), taskId: id(2), taskBriefId: id(3), assignmentAttemptId: id(4), callId: id(8) });
  });

  it('tool sonucunu sonraki provider turuna tool mesajı olarak taşır', async () => {
    const provider = new MockProvider({ script: [
      { content: null, toolCalls: [{ id: id(8), name: 'read_file', args: { path: 'a.ts' } }] },
      { content: 'tamamlandı', toolCalls: [] },
    ] });
    const result = await runWorkerLoop({ brief, attempt, snapshot, modelRef: 'mock:mock-model', router: router(provider), prompt: [{ role: 'user', content: 'iş' }], tools: { definitions: () => [{ name: 'read_file', description: '', parameters: {} }], validate: (_name, args) => args, execute: async () => ({ content: 'ok' }) }, communication: { report: async () => undefined, question: async () => ({ messageId: id(9) }) } });
    expect(result.reason).toBe('report');
    expect(provider.calls[1]!.messages.some((message) => message.role === 'tool' && message.toolCallId === id(8))).toBe(true);
  });

  it('brief dışı veya şema dışı tool injectionı çalıştırmadan reddeder', async () => {
    const provider = new MockProvider({ script: [{ content: null, toolCalls: [{ id: id(8), name: 'write_file', args: { path: 'x' } }] }] });
    let executions = 0;
    const result = await runWorkerLoop({ brief, attempt, snapshot, modelRef: 'mock:mock-model', router: router(provider), prompt: [{ role: 'user', content: 'iş' }], tools: { definitions: () => [{ name: 'read_file', description: '', parameters: {} }], validate: () => { throw new Error('unknown tool'); }, execute: async () => { executions += 1; return {}; } } });
    expect(result.reason).toBe('failure');
    expect(executions).toBe(0);
  });

  it('provider fallback ile temiz rapora ulaşır', async () => {
    const primary = new MockProvider({ script: [], failFirst: 1 });
    const fallback = new MockProvider({ script: [{ content: 'fallback tamam', toolCalls: [] }] });
    const routed = new ModelRouter(new Map([['primary', primary], ['fallback', fallback]]), { fallbacks: () => ['fallback:mock-model'], usageSink: async () => undefined, invocationEffect: { run: async ({ execute }) => execute() } });
    const result = await runWorkerLoop({ brief, attempt, snapshot, modelRef: 'primary:mock-model', router: routed, prompt: [{ role: 'user', content: 'iş' }], tools: { definitions: () => [], validate: () => ({}), execute: async () => ({}) }, communication: { report: async () => undefined, question: async () => ({ messageId: id(9) }) } });
    expect(result.reason).toBe('report');
    expect(fallback.calls).toHaveLength(1);
  });

  it('maxTurns sert üst sınırı ve model tool görünürlüğünü uygular', async () => {
    const provider = new MockProvider({ script: [{ content: 'ok', toolCalls: [] }] });
    const result = await runWorkerLoop({ brief, attempt, snapshot, modelRef: 'mock:mock-model', router: router(provider), maxTurns: 32, prompt: [{ role: 'user', content: 'iş' }], tools: { definitions: () => [{ name: 'read_file', description: '', parameters: {} }, { name: 'write_file', description: '', parameters: {} }], validate: (_name, args) => args, execute: async () => ({}) }, communication: { report: async () => undefined, question: async () => ({ messageId: id(9) }) } });
    expect(result.reason).toBe('report');
    expect(provider.calls[0]!.tools?.map((tool) => tool.name)).toEqual(['read_file']);
    await expect(runWorkerLoop({ brief, attempt, snapshot, modelRef: 'mock:mock-model', router: router(provider), maxTurns: 33, prompt: [{ role: 'user', content: 'iş' }], tools: { definitions: () => [], validate: () => ({}), execute: async () => ({}) } })).rejects.toThrow('1 ile 32');
  });

  it('ask_question null/non-string contenti mesajlaştırmaz', async () => {
    const provider = new MockProvider({ script: [{ content: null, toolCalls: [{ id: id(8), name: 'ask_question', args: { content: null } }] }] });
    let sent = false;
    const result = await runWorkerLoop({ brief, attempt, snapshot, modelRef: 'mock:mock-model', router: router(provider), prompt: [{ role: 'user', content: 'iş' }], tools: { definitions: () => [{ name: 'ask_question', description: '', parameters: {} }], validate: (_name, args) => args, execute: async () => ({}) }, communication: { question: async () => { sent = true; return { messageId: id(9) }; }, report: async () => undefined } });
    expect(result.reason).toBe('failure');
    expect(sent).toBe(false);
  });
});
