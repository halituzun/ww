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

// ASIL KUSUR: worker döngüsünün SEKİZ ayrı 'failure' dönüşü vardı ve hiçbiri
// sebep taşımıyordu. Görev düşüyor, ne logda ne veritabanında tek satır iz
// kalmıyordu — santranç görevi tam olarak böyle sessizce düştü.
describe('runWorkerLoop başarısızlık sebebi', () => {
  const brief = {
    projectId: id(1), taskId: id(2), taskBriefId: id(3),
    allowedTools: ['read_file'], acceptanceCriteria: ['x'],
  } as never;
  const attempt = {
    assignmentAttemptId: id(4), projectId: id(1), taskId: id(2),
    taskBriefId: id(3), workerAgentId: id(5), verifierAgentId: id(6),
  } as never;
  const snapshot = { invocationId: id(7), promptInputSnapshotId: id(8) } as never;

  const loop = (over: Record<string, unknown>) => runWorkerLoop({
    brief, attempt, snapshot, modelRef: 'm', prompt: [],
    tools: { definitions: () => [{ name: 'read_file' }], validate: () => ({}), execute: async () => ({}) } as never,
    communication: { question: async () => ({ messageId: id(9) }), report: async () => undefined } as never,
    ...over,
  } as never);

  it('kayıtlı olmayan araç istendiğinde sebebi bildirir', async () => {
    const result = await loop({
      router: { complete: async () => ({ result: { toolCalls: [{ name: 'rm_rf', callId: id(9), args: {} }] } }) },
    });

    expect(result.reason).toBe('failure');
    expect(result.detail).toMatch(/rm_rf/);
  });

  it('boş özet döndüğünde sebebi bildirir', async () => {
    const result = await loop({
      router: { complete: async () => ({ result: { toolCalls: [], content: '   ' } }) },
    });

    expect(result.reason).toBe('failure');
    expect(result.detail).toMatch(/özet|ozet/i);
  });

  it('iletişim kanalı yokken sebebi bildirir', async () => {
    const result = await loop({
      communication: undefined,
      router: { complete: async () => ({ result: { toolCalls: [], content: 'bitti' } }) },
    });

    expect(result.reason).toBe('failure');
    expect(result.detail).toMatch(/iletişim|iletisim/i);
  });
});

// ASIL KUSUR: araç hatası TÜM görevi düşürüyordu. Model henüz var olmayan bir
// dosyayı okumaya kalkınca ("Dosya bulunamadı") iş ölüyordu; oysa doğru
// davranış hatayı modele bildirip uyarlanmasına izin vermektir.
describe('runWorkerLoop araç hatası', () => {
  const brief = {
    projectId: id(1), taskId: id(2), taskBriefId: id(3),
    allowedTools: ['read_file', 'report_result'], acceptanceCriteria: ['x'],
  } as never;
  const attempt = {
    assignmentAttemptId: id(4), projectId: id(1), taskId: id(2),
    taskBriefId: id(3), workerAgentId: id(5), verifierAgentId: id(6),
  } as never;
  const snapshot = { invocationId: id(7), promptInputSnapshotId: id(8) } as never;

  it('hatayı modele geri verir ve döngü sürer', async () => {
    let call = 0;
    const seen: unknown[] = [];
    const result = await runWorkerLoop({
      brief, attempt, snapshot, modelRef: 'm', prompt: [],
      router: {
        complete: async (_ref: unknown, request: { messages: unknown[] }) => {
          call += 1;
          seen.push(request.messages);
          return call === 1
            ? { result: { toolCalls: [{ name: 'read_file', id: 'c1', args: { path: 'src/Board.tsx' } }] } }
            : { result: { toolCalls: [], content: 'dosya yoktu, oluşturdum' } };
        },
      } as never,
      tools: {
        definitions: () => [{ name: 'read_file' }, { name: 'report_result' }],
        validate: () => ({}),
        execute: async () => { throw new Error('Dosya bulunamadı: src/Board.tsx'); },
      } as never,
      communication: { question: async () => ({ messageId: id(9) }), report: async () => undefined } as never,
    } as never);

    expect(result.reason).toBe('report');
    expect(call).toBe(2);
    const second = seen[1] as { role: string; content?: string }[];
    expect(JSON.stringify(second)).toContain('Dosya bulunamadı');
  });

  // docs/05 Hata ve Retry: "Araç argüman hatası (şema uyumsuz) → Modele hata
  // mesajı döner, AYNI TURDA düzeltmesi beklenir (retry maliyeti düşük)."
  // Uygulanmıyordu: şema hatası görevi anında düşürüyordu. Canlı veride bu
  // iki görevi öldürmüş (write_file şema hatası ve bir Zod hatası).
  //
  // Brief DIŞI araç istemek ayrı bir konudur ve sert reddedilmeye devam eder:
  // o bir sınır ihlalidir, düzeltilebilir bir yazım hatası değil.
  it('sema hatasinda modele hatayi dondurur ve duzeltmesine izin verir', async () => {
    const provider = new MockProvider({ script: [
      { content: null, toolCalls: [{ id: id(8), name: 'read_file', args: { yol: 'a.ts' } }] },
      { content: 'düzelttim ve bitirdim', toolCalls: [] },
    ] });
    let calls = 0;
    const result = await runWorkerLoop({
      brief, attempt, snapshot, modelRef: 'mock:mock-model', router: router(provider),
      prompt: [{ role: 'user', content: 'iş' }],
      tools: {
        definitions: () => [{ name: 'read_file', description: '', parameters: {} }],
        validate: (_name, args) => {
          calls += 1;
          if (calls === 1) throw new Error("'path' alanı zorunlu");
          return args;
        },
        execute: async () => ({}),
      },
      communication: { report: async () => undefined, question: async () => ({ messageId: id(9) }) },
    });

    // Görev DÜŞMEZ; model kendini düzeltir.
    expect(result.reason).toBe('report');
    // Hata modele ARAÇ CEVABI olarak döner: yoksa neyi düzelteceğini bilemez.
    const second = provider.calls[1]!.messages;
    expect(second.some((message) => message.role === 'tool'
      && message.toolCallId === id(8)
      && String(message.content).includes('path'))).toBe(true);
  });

  it('sema hatasi duzelmezse tur siniri icinde yine de duser', async () => {
    const provider = new MockProvider({ script: Array.from({ length: 4 }, () => (
      { content: null, toolCalls: [{ id: id(8), name: 'read_file', args: {} }] }
    )) });
    const result = await runWorkerLoop({
      brief, attempt, snapshot, modelRef: 'mock:mock-model', router: router(provider),
      prompt: [{ role: 'user', content: 'iş' }], maxTurns: 3,
      tools: {
        definitions: () => [{ name: 'read_file', description: '', parameters: {} }],
        validate: () => { throw new Error('hep bozuk'); },
        execute: async () => ({}),
      },
      communication: { report: async () => undefined, question: async () => ({ messageId: id(9) }) },
    } as never);
    // Sonsuz düzeltme turu YOK: tur sınırı freni yerinde kalır.
    expect(result.reason).not.toBe('report');
  });
});
