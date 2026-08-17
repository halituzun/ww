import { describe, expect, it, vi } from 'vitest';
import { pumpOnce, type TaskPumpPorts } from './task-pump.js';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

const item = (n: number) => ({ msgId: `1-${n}`, taskId: id(n) as never });

function ports(over: Partial<TaskPumpPorts> = {}): TaskPumpPorts {
  return {
    claim: async () => [item(1)],
    ack: vi.fn(async () => undefined),
    orchestrate: vi.fn(async () => ({ status: 'done' })),
    maxAttempts: 3,
    ...over,
  };
}

describe('pumpOnce', () => {
  it('boş kuyrukta hiçbir iş yapmaz', async () => {
    const orchestrate = vi.fn(async () => ({ status: 'done' }));
    const result = await pumpOnce(ports({ claim: async () => [], orchestrate }));

    expect(result.processed).toBe(0);
    expect(orchestrate).not.toHaveBeenCalled();
  });

  it('görevi orkestre eder ve ack’ler', async () => {
    const ack = vi.fn(async () => undefined);
    const orchestrate = vi.fn(async () => ({ status: 'done' }));
    const result = await pumpOnce(ports({ ack, orchestrate }));

    expect(orchestrate).toHaveBeenCalledTimes(1);
    expect(orchestrate.mock.calls[0]![0]).toMatchObject({ taskId: id(1), maxAttempts: 3 });
    expect(ack).toHaveBeenCalledWith('1-1');
    expect(result.results[0]).toMatchObject({ taskId: id(1), status: 'done' });
  });

  // ACK ETMEK İŞİ KAYBETMEKTİR: hata durumunda mesaj pending kalmalı ki
  // reclaim başka bir tüketiciye devretsin. Aksi halde görev sessizce yok olur.
  it('orkestrasyon hatasında ack ETMEZ', async () => {
    const ack = vi.fn(async () => undefined);
    const failing = ports({ ack, orchestrate: async () => { throw new Error('model düştü'); } });

    const result = await pumpOnce(failing);
    expect(ack).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({ taskId: id(1), status: 'error' });
  });


  // Yutulan hata, kuyruğun neden dolduğunu görünmez kılar.
  it('hatayı onError ile bildirir', async () => {
    const onError = vi.fn();
    await pumpOnce(ports({ onError, orchestrate: async () => { throw new Error('model düştü'); } }));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]![1])).toMatch(/model düştü/);
  });

  it('bir görevin hatası sonrakileri engellemez', async () => {
    const orchestrate = vi.fn(async ({ taskId }: { taskId: string }) => {
      if (taskId === id(1)) throw new Error('ilk görev düştü');
      return { status: 'done' };
    });
    const ack = vi.fn(async () => undefined);
    const result = await pumpOnce(ports({
      claim: async () => [item(1), item(2)],
      orchestrate: orchestrate as never,
      ack,
    }));

    expect(result.processed).toBe(2);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith('1-2');
  });

  it('terminal olmayan durumu da ack’ler', async () => {
    // Soru bekleyen görev kuyruğa geri dönmemeli: cevabı ayrı akış sürdürür.
    const ack = vi.fn(async () => undefined);
    const result = await pumpOnce(ports({ ack, orchestrate: async () => ({ status: 'awaiting_user' }) }));

    expect(ack).toHaveBeenCalledWith('1-1');
    expect(result.results[0]!.status).toBe('awaiting_user');
  });

  it('sonucu onResult ile bildirir', async () => {
    const onResult = vi.fn();
    await pumpOnce(ports({ onResult }));
    expect(onResult).toHaveBeenCalledWith(id(1), 'done');
  });

  // Ack'in kendisi düşerse iş YAPILMIŞTIR; pompa bunu hata sayıp durmamalı
  // ama sessiz de geçmemeli, yoksa mesaj sonsuza dek yeniden teslim edilir.
  it('ack hatası bildirilir ama pompa çalışmaya devam eder', async () => {
    const onError = vi.fn();
    const result = await pumpOnce(ports({
      onError,
      ack: async () => { throw new Error('redis düştü'); },
    }));

    expect(result.processed).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

});
