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
  const transition = vi.fn(async () => undefined);
  const log = vi.fn();
  return {
    appendEvent, transition, log,
    handle: createExecutionErrorRecorder({
      appendEvent, transition, log, now: () => '2026-08-17T09:00:00.000Z', ...over,
    }),
  };
};

describe('createExecutionErrorRecorder', () => {
  it('gecis sonucu okunamazsa failed varsayar', async () => {
    const { handle } = recorder();
    expect(await handle(call())).toBe('failed');
  });

  // ASIL KUSUR (2026-08-31): bu fonksiyon KOŞULSUZ 'failed' dönüyordu, ama
  // uyguladığı geçiş her zaman 'failed' üretmez: 'verifier_rejected' ve
  // 'gate_failed' görevi (deneme hakkı bitmedikçe) 'working'e geri döndürür.
  // Görev pompası 'failed'i "kapanabilir" sayıp mesajı kuyruktan SİLİYORDU:
  // tasks satırı 'working', kuyrukta kayıt yok, agent'lar 'busy' kilitli,
  // panel "çalışıyor" diyor — görev sessizce asılı kalıyordu.
  it('gecisin GERCEK sonucunu dondurur (working ise failed demez)', async () => {
    const transition = vi.fn(async () => ({ status: 'working' }));
    const { handle } = recorder({ transition });
    expect(await handle(call({ phase: 'verifying' }))).toBe('working');
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'verifier_rejected' }),
    );
  });

  it('kapi hatasinda gate_failed gecisi uygular ve sonucunu dondurur', async () => {
    const transition = vi.fn(async () => ({ status: 'escalated' }));
    const { handle } = recorder({ transition });
    expect(await handle(call({ phase: 'testing' }))).toBe('escalated');
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'gate_failed' }),
    );
  });

  it('gecis reddedilirse failed dondurur ve sessiz kalmaz', async () => {
    const transition = vi.fn(async () => { throw new Error('gecersiz FSM gecisi'); });
    const { handle, log } = recorder({ transition });
    expect(await handle(call())).toBe('failed');
    expect(log.mock.calls.flat().join(' ')).toContain('geçirilemedi');
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
    // Yük artık NESNE; metne çevirip aramak alanların varlığını doğrular.
    expect(JSON.stringify(row['payload'])).toContain('deepseek 429 rate limit');
  });

  it('hangi aşamada düştüğünü kaydeder', async () => {
    const { appendEvent, handle } = recorder();
    await handle(call({ phase: 'verifying' }));
    expect(JSON.stringify((appendEvent.mock.calls[0]![0] as never as Record<string, unknown>)['payload']))
      .toContain('verifying');
  });

  it('denemeyi olaya bağlar', async () => {
    const { appendEvent, handle } = recorder();
    await handle(call());
    expect(JSON.stringify((appendEvent.mock.calls[0]![0] as never as Record<string, unknown>)['payload']))
      .toContain(id(4));
  });

  it('Error olmayan sebebi de metne çevirir', async () => {
    const { appendEvent, handle } = recorder();
    await handle(call({ error: 'düz metin hata' }));
    expect(JSON.stringify((appendEvent.mock.calls[0]![0] as never as Record<string, unknown>)['payload']))
      .toContain('düz metin hata');
  });

  it('operatöre de bildirir', async () => {
    const { log, handle } = recorder();
    await handle(call());
    // İLK satır düşme sebebidir. Tanı amaçlı ek satırlar (ör. "geçiş sonucu
    // okunamadı") gelebilir; sayıyı sabitlemek, teşhis eklemeyi cezalandırırdı.
    expect(String(log.mock.calls[0]![0])).toMatch(/429/);
    expect(log.mock.calls.length).toBeGreaterThanOrEqual(1);
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
      transition: async () => undefined,
      log, now: () => '2026-08-17T09:00:00.000Z',
    });
    await handle(call());
    expect(log.mock.calls.some((entry) => String(entry[0]).includes('clickhouse kapalı'))).toBe(true);
  });
  // ASIL KUSUR: kaydedici yalnızca 'failed' STRING'i dönüyordu; hiçbir geçiş
  // yapılmadığı için görev satırı 'assigned' kalıyor ve DOSYA KİLİDİ
  // bırakılmıyordu. Sonuç: aynı dosyayı hedefleyen sonraki görev TTL dolana
  // dek çakışıyordu.
  it('görevi fail durumuna geçirir', async () => {
    const { transition, handle } = recorder();
    await handle(call());

    expect(transition).toHaveBeenCalledTimes(1);
    const sent = transition.mock.calls[0]![0] as never as Record<string, unknown>;
    expect(sent['action']).toBe('fail');
    expect(sent['taskId']).toBe(id(2));
    expect(String(sent['resultSummary'])).toContain('deepseek 429 rate limit');
  });

  it('geçiş düşse bile failed döner ve bildirilir', async () => {
    const { log, handle } = recorder({
      transition: async () => { throw new Error('geçiş reddedildi'); },
    });

    expect(await handle(call())).toBe('failed');
    expect(log.mock.calls.some((entry) => String(entry[0]).includes('geçiş reddedildi'))).toBe(true);
  });

  it('geçiş düşse bile hata olayı yazılır', async () => {
    const { appendEvent, handle } = recorder({
      transition: async () => { throw new Error('geçiş reddedildi'); },
    });
    await handle(call());
    expect(appendEvent).toHaveBeenCalledTimes(1);
  });

  // Yığın izi olmadan hatanın nerede oluştuğu koda bakarak aranır.
  it('Error ise yığın izini de kaydeder', async () => {
    const { appendEvent, handle } = recorder();
    await handle(call());
    const payload = JSON.stringify((appendEvent.mock.calls[0]![0] as never as Record<string, unknown>)['payload']);
    expect(JSON.parse(payload).stack).toContain('execution-error-recorder.test');
  });

  // FSM'de 'fail' yalnızca working'den geçerlidir; aşamaya bakmadan
  // göndermek görevi takılı bırakıyordu.
  it('testing aşamasında gate_failed geçişi kullanır', async () => {
    const { transition, handle } = recorder();
    await handle(call({ phase: 'testing' }));
    expect((transition.mock.calls[0]![0] as never as Record<string, unknown>)['action'])
      .toBe('gate_failed');
  });

  it('verifying aşamasında verifier_rejected kullanır', async () => {
    const { transition, handle } = recorder();
    await handle(call({ phase: 'verifying' }));
    expect((transition.mock.calls[0]![0] as never as Record<string, unknown>)['action'])
      .toBe('verifier_rejected');
  });

  // ÖLÇÜLDÜ (canlı ClickHouse, 2026-08-18): 69 `error` olayının 69'unda
  // `JSONExtractString(payload,'reason')` BOŞ dönüyor. Sebep aslında YAZILI
  // ama yük ÇİFT KODLANMIŞ: `payload` alanı zaten JsonValue ve depo onu
  // serileştiriyor; kaydedici önceden JSON.stringify yapınca ortaya JSON
  // NESNESİ değil JSON METNİ çıkıyor.
  //
  // Bedeli: denetim ekranı, anlatıcı ve her analitik sorgu sebebi okuyamıyor.
  // Anlatıcı bu yüzden "hata: sebep kaydedilmemiş" diyor — sebep orada
  // duruyorken. Yani kayıt var, okunamıyor: sessiz yanlışlığın en kötü türü.
  it('yuku NESNE olarak yazar, cift kodlamaz', async () => {
    const { appendEvent, handle } = recorder();
    await handle(call());

    const row = appendEvent.mock.calls[0]![0] as unknown as Record<string, unknown>;
    const payload = row['payload'];
    expect(typeof payload).toBe('object');
    expect(payload).toMatchObject({
      phase: 'working',
      reason: expect.stringContaining('deepseek 429 rate limit'),
    });
  });

  it('sebep JSONExtract ile okunabilir olmali', async () => {
    const { appendEvent, handle } = recorder();
    await handle(call());
    const row = appendEvent.mock.calls[0]![0] as unknown as Record<string, unknown>;
    // ClickHouse tarafında `JSONExtractString(payload,'reason')` bunu okur.
    const reason = (row['payload'] as Record<string, unknown>)['reason'];
    expect(typeof reason).toBe('string');
    expect(String(reason).length).toBeGreaterThan(0);
  });
});
