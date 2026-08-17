import { describe, expect, it, vi } from 'vitest';
import { createExecutionErrorRecorder } from './execution-error-recorder.js';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

const attempt = {
  assignmentAttemptId: id(4), projectId: id(1), taskId: id(2),
  taskBriefId: id(3), workerAgentId: id(5),
} as never;

const call = (over: Record<string, unknown> = {}) => ({
  taskId: id(2) as never,
  attempt,
  phase: 'working' as const,
  error: new Error('deepseek 429 rate limit'),
  ...over,
});

const recorder = (over: Partial<Parameters<typeof createExecutionErrorRecorder>[0]> = {}) => {
  const appendEvent = vi.fn(async () => undefined);
  const log = vi.fn();
  return {
    appendEvent, log,
    handle: createExecutionErrorRecorder({
      appendEvent, log, now: () => '2026-08-17T09:00:00.000Z', ...over,
    }),
  };
};

describe('createExecutionErrorRecorder', () => {
  it('failed durumunu döner', async () => {
    const { handle } = recorder();
    expect(await handle(call())).toBe('failed');
  });

  // ASIL KUSUR: handleExecutionError sabit 'failed' dönen bir taslaktı ve
  // hatayı tümüyle çöpe atıyordu. Sebep hiçbir yere yazılmadığı için
  // başarısızlık teşhis edilemiyordu.
  it('hatanın sebebini olay olarak yazar', async () => {
    const { appendEvent, handle } = recorder();
    await handle(call());

    expect(appendEvent).toHaveBeenCalledTimes(1);
    const row = appendEvent.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(row['event_type']).toBe('error');
    expect(row['task_id']).toBe(id(2));
    expect(row['project_id']).toBe(id(1));
    expect(String(row['payload'])).toContain('deepseek 429 rate limit');
  });

  it('hangi aşamada düştüğünü kaydeder', async () => {
    const { appendEvent, handle } = recorder();
    await handle(call({ phase: 'verifying' }));
    expect(String((appendEvent.mock.calls[0]![0] as never as Record<string, unknown>)['payload']))
      .toContain('verifying');
  });

  it('denemeyi olaya bağlar', async () => {
    const { appendEvent, handle } = recorder();
    await handle(call());
    expect(String((appendEvent.mock.calls[0]![0] as never as Record<string, unknown>)['payload']))
      .toContain(id(4));
  });

  it('Error olmayan sebebi de metne çevirir', async () => {
    const { appendEvent, handle } = recorder();
    await handle(call({ error: 'düz metin hata' }));
    expect(String((appendEvent.mock.calls[0]![0] as never as Record<string, unknown>)['payload']))
      .toContain('düz metin hata');
  });

  it('operatöre de bildirir', async () => {
    const { log, handle } = recorder();
    await handle(call());
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toMatch(/429/);
  });

  // Kayıt yazılamazsa bile görev 'failed' olmalı: kaydedici, hata yolunu
  // ikinci bir hatayla kırıp durumu belirsiz bırakmamalı.
  it('olay yazımı düşse bile failed döner', async () => {
    const { handle } = recorder({ appendEvent: async () => { throw new Error('clickhouse kapalı'); } });
    expect(await handle(call())).toBe('failed');
  });

  it('olay yazımı düşerse bunu da bildirir', async () => {
    const log = vi.fn();
    const handle = createExecutionErrorRecorder({
      appendEvent: async () => { throw new Error('clickhouse kapalı'); },
      log, now: () => '2026-08-17T09:00:00.000Z',
    });
    await handle(call());
    expect(log.mock.calls.some((entry) => String(entry[0]).includes('clickhouse kapalı'))).toBe(true);
  });
});
