import { describe, expect, it, vi } from 'vitest';
import {
  createExecutorComposition,
  createResumeUserAnswerOperation,
  type ExecutorCompositionDeps,
  type ResumeAssignmentPort,
} from './executor-composition.js';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

function deps(over: Partial<ExecutorCompositionDeps> = {}): ExecutorCompositionDeps {
  return {
    sandbox: { run: vi.fn() } as never,
    hostCommand: { run: vi.fn() } as never,
    access: { assertWritable: vi.fn() } as never,
    auditStore: { append: vi.fn(async () => undefined) } as never,
    communication: {
      askQuestion: vi.fn(async () => ({ ok: true }) as never),
      reportResult: vi.fn(async () => ({ ok: true }) as never),
      submitVerdict: vi.fn(async () => ({ ok: true }) as never),
    },
    ...over,
  };
}

describe('createExecutorComposition', () => {
  it('composition’ın beklediği tüm portları sağlar', () => {
    const executor = createExecutorComposition(deps());
    for (const port of [
      'sandbox', 'gateAudit', 'gateInputPolicy', 'hostCommand', 'access',
      'communication', 'audit', 'effects', 'intents', 'sandboxInputs',
    ]) {
      expect(executor, `eksik port: ${port}`).toHaveProperty(port);
    }
  });

  it('iletişim portunu doğrudan geçirir', async () => {
    const d = deps();
    const executor = createExecutorComposition(d);
    await executor.communication.askQuestion({ question: 'x' } as never);
    expect(d.communication.askQuestion).toHaveBeenCalled();
  });

  // Uygulanmamış port sessizce 'başarılı' dönmemeli: worker gerçekte
  // çalışmayan bir yeteneği çalışmış sanır ve hata görünmez olur.
  it('uygulanmamış efekt portu açık hata verir', async () => {
    const executor = createExecutorComposition(deps());
    await expect(executor.effects.run({} as never)).rejects.toThrow(/uygulanmad|desteklenmi/i);
  });

  it('uygulanmamış sandbox girdi politikası açık hata verir', async () => {
    const executor = createExecutorComposition(deps());
    await expect(executor.sandboxInputs.resolveTrustedInputs({} as never))
      .rejects.toThrow(/uygulanmad|desteklenmi/i);
  });

  // Kapı girdi politikası varsayılan olarak izin verir; kısıt gate config'de.
  it('kapı girdi politikası varsayılan izinlidir', async () => {
    const executor = createExecutorComposition(deps());
    await expect(executor.gateInputPolicy.assertAllowed({} as never)).resolves.toBeUndefined();
  });

  // Denetim katmanı geçersiz olayı da, depo hatasını da yutmamalı: yutulan
  // denetim kaydı, olmayan denetimden kötüdür (var sanılır).
  it('geçersiz denetim olayını sessizce kabul etmez', async () => {
    const executor = createExecutorComposition(deps());
    await expect(executor.audit.append({ eventId: id(1) } as never)).rejects.toThrow();
  });
});

describe('createResumeUserAnswerOperation', () => {
  function port() {
    const calls: Record<string, unknown>[] = [];
    const impl: ResumeAssignmentPort = {
      resumeUserAnswer: vi.fn(async (value) => {
        calls.push(value as unknown as Record<string, unknown>);
        return { assignmentAttemptId: id(9), attemptNumber: 2 } as never;
      }),
    };
    return { impl, calls };
  }

  it('cevabı servise iletir ve yeni attempt döner', async () => {
    const { impl, calls } = port();
    const resume = createResumeUserAnswerOperation(impl);
    const next = await resume({
      projectId: id(1), taskId: id(2), taskBriefId: id(3), previousAttemptId: id(4),
      questionMessageId: id(5), replyMessageId: id(6), answer: 'src klasörü',
    });
    expect(next.attemptNumber).toBe(2);
    expect(calls[0]).toMatchObject({ taskId: id(2), answer: 'src klasörü' });
  });

  // Boş cevapla devam etmek, worker'ı bilgisiz yeniden başlatmaktır.
  it('boş cevabı reddeder', async () => {
    const { impl } = port();
    await expect(createResumeUserAnswerOperation(impl)({
      projectId: id(1), taskId: id(2), taskBriefId: id(3), previousAttemptId: id(4),
      questionMessageId: id(5), replyMessageId: id(6), answer: '   ',
    // Not: Türkçe ünsüz yumuşaması — 'cevabı' içinde 'cevap' geçmez (p→b).
    })).rejects.toThrow(/ceva[pb]/i);
  });

  // Cevap mesajı soru mesajıyla aynı olamaz: kendi sorusunu cevap sayan
  // bir döngü sonsuza kadar kendini besler.
  it('cevap ve soru mesajı aynıysa reddeder', async () => {
    const { impl } = port();
    await expect(createResumeUserAnswerOperation(impl)({
      projectId: id(1), taskId: id(2), taskBriefId: id(3), previousAttemptId: id(4),
      questionMessageId: id(5), replyMessageId: id(5), answer: 'x',
    })).rejects.toThrow(/aynı/i);
  });
});
