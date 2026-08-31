import { describe, expect, it, vi } from 'vitest';
import {
  createAwaitUserAnswerOperation,
  createReassignOperation,
  type AssignmentOperationPort,
  type UserQuestionPort,
} from './assignment-operations.js';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

const attempt = {
  assignmentAttemptId: id(4), projectId: id(1), taskId: id(2), taskBriefId: id(3),
  attemptNumber: 1, workerAgentId: id(5), verifierAgentId: id(6),
} as never;

function assignmentPort() {
  const calls: Record<string, unknown>[] = [];
  const port: AssignmentOperationPort = {
    reassign: vi.fn(async (value) => {
      calls.push(value as unknown as Record<string, unknown>);
      return { ...attempt, assignmentAttemptId: id(9), attemptNumber: 2 } as never;
    }),
  };
  return { port, calls };
}

describe('createReassignOperation', () => {
  it('yeni attempt döndürür', async () => {
    const { port } = assignmentPort();
    const reassign = createReassignOperation(port);
    const next = await reassign({ taskId: id(2), reason: 'retry_after_rejection', evidenceRefs: [] });
    expect(next.attemptNumber).toBe(2);
  });

  it('servisin beklediği alanları doldurur', async () => {
    const { port, calls } = assignmentPort();
    await createReassignOperation(port)({
      taskId: id(2), reason: 'retry_after_gate_failure', evidenceRefs: ['gate'],
    });
    expect(calls[0]).toMatchObject({ taskId: id(2) });
    expect(typeof calls[0]!['requestedAt']).toBe('string');
    expect(typeof calls[0]!['causationId']).toBe('string');
  });

  // Her yeniden atama ayrı bir nedensel olaydır; aynı causationId iki denemeyi
  // birbirine karıştırır.
  it('her çağrı için benzersiz causationId üretir', async () => {
    const { port, calls } = assignmentPort();
    const reassign = createReassignOperation(port);
    await reassign({ taskId: id(2), reason: 'retry_after_rejection', evidenceRefs: [] });
    await reassign({ taskId: id(2), reason: 'retry_after_rejection', evidenceRefs: [] });
    expect(calls[0]!['causationId']).not.toBe(calls[1]!['causationId']);
  });

  it('geçersiz gerekçeyi reddeder', async () => {
    const { port } = assignmentPort();
    await expect(createReassignOperation(port)({
      taskId: id(2), reason: 'uydurma' as never, evidenceRefs: [],
    })).rejects.toThrow(/gerekçe|reason/i);
  });
});

describe('createAwaitUserAnswerOperation', () => {
  function questionPort() {
    const asked: Record<string, unknown>[] = [];
    const port: UserQuestionPort = {
      recordQuestion: vi.fn(async (value) => { asked.push(value as unknown as Record<string, unknown>); }),
    };
    return { port, asked };
  }

  it('soruyu kaydeder', async () => {
    const { port, asked } = questionPort();
    await createAwaitUserAnswerOperation(port)({
      taskId: id(2), attempt, question: 'hangi klasör?',
    });
    expect(asked[0]).toMatchObject({ taskId: id(2), question: 'hangi klasör?' });
  });

  it('soru mesajı kimliğini taşır', async () => {
    const { port, asked } = questionPort();
    await createAwaitUserAnswerOperation(port)({
      taskId: id(2), attempt, question: 'hangi klasör?', questionMessageId: id(7),
    });
    expect(asked[0]).toMatchObject({ questionMessageId: id(7) });
  });

  // Boş soru kullanıcıya anlamsız bir bekleme yaratır; görev sonsuza dek
  // waiting_user'da kalır.
  it('boş soruyu reddeder', async () => {
    const { port } = questionPort();
    await expect(createAwaitUserAnswerOperation(port)({
      taskId: id(2), attempt, question: '   ',
    })).rejects.toThrow(/soru/i);
  });

  it('attempt bağlamını kayda iliştirir', async () => {
    const { port, asked } = questionPort();
    await createAwaitUserAnswerOperation(port)({ taskId: id(2), attempt, question: 'x' });
    expect(asked[0]).toMatchObject({
      assignmentAttemptId: id(4), taskBriefId: id(3), projectId: id(1),
    });
  });
});
