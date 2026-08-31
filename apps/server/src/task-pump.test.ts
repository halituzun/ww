import { describe, expect, it, vi } from 'vitest';
import { pumpOnce, type TaskPumpPorts } from './task-pump.js';
import { pumpConcurrency } from './task-pump.service.js';

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


  // ASIL KUSUR: terminal olmayan sonuçta da ack ediliyordu; görev retry
  // edilebilir bir duruma düşerken kuyruk kaydı kapanıyor, iş asılı kalıyor
  // ve agent'ları tutuyordu.
  it('terminal olmayan sonuçta ack ETMEZ', async () => {
    const ack = vi.fn(async () => undefined);
    const result = await pumpOnce(ports({ ack, orchestrate: async () => ({ status: 'working' }) }));

    expect(ack).not.toHaveBeenCalled();
    expect(result.results[0]!.status).toBe('working');
  });

  it('done sonucunda ack eder', async () => {
    const ack = vi.fn(async () => undefined);
    await pumpOnce(ports({ ack, orchestrate: async () => ({ status: 'done' }) }));
    expect(ack).toHaveBeenCalledWith('1-1');
  });

  it('escalated sonucunda da ack eder', async () => {
    const ack = vi.fn(async () => undefined);
    await pumpOnce(ports({ ack, orchestrate: async () => ({ status: 'escalated' }) }));
    expect(ack).toHaveBeenCalledWith('1-1');
  });

  // docs/07: "Proje başına paralel agent 5". Pompa görevleri SERİ işliyordu:
  // canlı koşuda iki görev aynı worker/verifier çiftini sırayla kullandı ve
  // kadrodaki ikinci çift hiç devreye girmedi. Belgelenmiş eşzamanlılık
  // yazılmış ama hiç çalışmıyordu.
  it('gorevleri sinira kadar es zamanli isler', async () => {
    let active = 0;
    let peak = 0;
    const orchestrate = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { status: 'done' };
    });

    const result = await pumpOnce(ports({
      claim: async () => [item(1), item(2), item(3)],
      orchestrate,
      concurrency: 3,
    }));

    expect(result.processed).toBe(3);
    expect(peak).toBeGreaterThan(1);
  });

  // Sınırsız eşzamanlılık sağlayıcı rate limitini ve agent kadrosunu aşar.
  it('es zamanlilik sinirini asmaz', async () => {
    let active = 0;
    let peak = 0;
    const orchestrate = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return { status: 'done' };
    });

    await pumpOnce(ports({
      claim: async () => [item(1), item(2), item(3), item(4), item(5)],
      orchestrate,
      concurrency: 2,
    }));

    expect(peak).toBeLessThanOrEqual(2);
  });

  it('varsayilan olarak seri calisir', async () => {
    let active = 0;
    let peak = 0;
    const orchestrate = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { status: 'done' };
    });

    await pumpOnce(ports({ claim: async () => [item(1), item(2)], orchestrate }));
    expect(peak).toBe(1);
  });

  // Eşzamanlı koşuda da her görevin sonucu kendi mesajına ait olmalıdır;
  // karışırsa yanlış mesaj ack'lenir ve iş kaybolur.
  it('es zamanli kosuda sonuclari gorevlerle eslestirir', async () => {
    const ack = vi.fn(async () => undefined);
    const orchestrate = vi.fn(async ({ taskId }: { taskId: string }) => {
      await new Promise((resolve) => setTimeout(resolve, taskId === id(1) ? 30 : 5));
      return { status: taskId === id(1) ? 'done' : 'working' };
    });

    const result = await pumpOnce(ports({
      claim: async () => [item(1), item(2)],
      orchestrate: orchestrate as never,
      ack,
      concurrency: 2,
    }));

    expect(result.results).toEqual([
      { taskId: id(1), status: 'done' },
      { taskId: id(2), status: 'working' },
    ]);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith('1-1');
  });
});

describe('pumpConcurrency', () => {
  it('varsayilan olarak iki gorev', () => {
    expect(pumpConcurrency(undefined)).toBe(2);
    expect(pumpConcurrency('')).toBe(2);
  });

  it('ayarlanan degeri kullanir', () => {
    expect(pumpConcurrency('4')).toBe(4);
  });

  // Bozuk ayar sessizce sınırsız eşzamanlılığa dönüşürse sağlayıcı rate
  // limiti ve agent kadrosu aşılır.
  it('bozuk degerde varsayilana duser', () => {
    for (const raw of ['abc', '0', '-3', '1.5']) {
      expect(pumpConcurrency(raw)).toBe(2);
    }
  });

  it('ust sinir uygular', () => {
    expect(pumpConcurrency('999')).toBe(8);
  });
});
