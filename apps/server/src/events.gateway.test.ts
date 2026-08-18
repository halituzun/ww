import { describe, expect, it, vi } from 'vitest';
import { EventsGateway } from './events.gateway.js';

// NEDEN VAR: bu ağ geçidinin HİÇ testi yoktu ve panelin canlı beslemesinin
// tamamı buradan geçiyor.
//
// ASIL KUSUR: geçersiz `projectId` ya da bozuk imleç `parse` içinde İSTİSNA
// atıyordu ve istemciye hiçbir şey dönmüyordu. Panel soketi açık gördüğü için
// "Canlı" yazıyor, ama tek bir olay bile gelmiyordu — "bağlı görünüp donan
// panel" kusurunun aynısı, bir kat aşağıda.
function fakeClient() {
  const sent: string[] = [];
  return {
    sent,
    client: {
      readyState: 1, OPEN: 1,
      send: (payload: string) => sent.push(payload),
      on: () => undefined,
    } as never,
  };
}

/** Sorgu METNİNİ de kaydeder: "hangi yoldan okudu" ancak böyle görülür. */
const gateway = (rows: Record<string, unknown>[] = []) => {
  const queries: string[] = [];
  const instance = new EventsGateway({
    ch: {
      query: async ({ query }: { query: string }) => {
        queries.push(query);
        return { json: async () => rows };
      },
    },
  } as never);
  return { instance, queries };
};

const projectId = '11111111-1111-4111-8111-111111111111';

describe('EventsGateway.subscribe', () => {
  it('gecersiz proje kimliginde istemciye RET bildirir', async () => {
    const { client, sent } = fakeClient();
    const { instance: target } = gateway();
    target.handleConnection(client);

    await target.subscribe(client, { projectId: 'proje-degil' });

    expect(sent).toHaveLength(1);
    const envelope = JSON.parse(sent[0]!) as { event: string; data: { reason: string } };
    expect(envelope.event).toBe('subscribe.rejected');
    expect(envelope.data.reason).not.toBe('');
  });

  it('bozuk imlecte de RET bildirir, sessizce susmaz', async () => {
    const { client, sent } = fakeClient();
    const { instance: target } = gateway();
    target.handleConnection(client);

    await target.subscribe(client, { projectId, afterCursor: 'bu-imleç-bozuk' });

    expect(JSON.parse(sent[0]!)).toMatchObject({ event: 'subscribe.rejected' });
  });

  // Ret sonrası yoklama zamanlayıcısı KURULMAMALI: aboneliği olmayan bir
  // istemci için saniyede bir ClickHouse sorgusu koşturmak sessiz bir yüktür.
  it('ret sonrasi yoklama baslatmaz', async () => {
    const { client } = fakeClient();
    const { instance: target } = gateway();
    target.handleConnection(client);
    const timer = vi.spyOn(globalThis, 'setInterval');

    await target.subscribe(client, { projectId: 'proje-degil' });

    expect(timer).not.toHaveBeenCalled();
    timer.mockRestore();
  });

  // ASIL KUSUR (ölçüldü): imleçsiz abonelikte `listEvents` EN ESKİ 200 olayı
  // döndürüyordu. Panel her açılışta sıfır imleçle bağlandığı için, 4511
  // olaylı bir projede canlı veriye ulaşmak saniyede 200 olayla ~23 saniye
  // sürüyordu; kullanıcı o süre boyunca ESKİ olayların akışını izliyordu.
  // docs/08 istemcinin "snapshot high-water"dan başlamasını söylüyor.
  it('imlecsiz abonelikte EN YENI olaylardan baslar', async () => {
    const { client } = fakeClient();
    const { instance: target, queries } = gateway();
    target.handleConnection(client);

    await target.subscribe(client, { projectId });

    // En yeni pencere DESC sıralamayla seçilir; eski uçtan taramak değil.
    expect(queries.join('\n')).toContain('DESC');
  });

  // İmleç VERİLDİYSE kaldığı yerden devam edilir: yeniden bağlanan panel
  // kaçırdığı olayları almalıdır, en yeniye atlamamalıdır.
  it('imlec verildiginde kaldigi yerden devam eder', async () => {
    const { client } = fakeClient();
    const { instance: target, queries } = gateway();
    target.handleConnection(client);

    await target.subscribe(client, {
      projectId,
      afterCursor: '2026-08-18T00:00:00.000Z|11111111-1111-4111-8111-111111111111',
    });

    expect(queries.join('\n')).toContain('afterCreatedAt');
  });
});
