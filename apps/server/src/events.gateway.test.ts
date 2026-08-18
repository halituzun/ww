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

const gateway = (rows: Record<string, unknown>[] = []) => new EventsGateway({
  ch: { query: async () => ({ json: async () => rows }) },
} as never);

const projectId = '11111111-1111-4111-8111-111111111111';

describe('EventsGateway.subscribe', () => {
  it('gecersiz proje kimliginde istemciye RET bildirir', async () => {
    const { client, sent } = fakeClient();
    const target = gateway();
    target.handleConnection(client);

    await target.subscribe(client, { projectId: 'proje-degil' });

    expect(sent).toHaveLength(1);
    const envelope = JSON.parse(sent[0]!) as { event: string; data: { reason: string } };
    expect(envelope.event).toBe('subscribe.rejected');
    expect(envelope.data.reason).not.toBe('');
  });

  it('bozuk imlecte de RET bildirir, sessizce susmaz', async () => {
    const { client, sent } = fakeClient();
    const target = gateway();
    target.handleConnection(client);

    await target.subscribe(client, { projectId, afterCursor: 'bu-imleç-bozuk' });

    expect(JSON.parse(sent[0]!)).toMatchObject({ event: 'subscribe.rejected' });
  });

  // Ret sonrası yoklama zamanlayıcısı KURULMAMALI: aboneliği olmayan bir
  // istemci için saniyede bir ClickHouse sorgusu koşturmak sessiz bir yüktür.
  it('ret sonrasi yoklama baslatmaz', async () => {
    const { client } = fakeClient();
    const target = gateway();
    target.handleConnection(client);
    const timer = vi.spyOn(globalThis, 'setInterval');

    await target.subscribe(client, { projectId: 'proje-degil' });

    expect(timer).not.toHaveBeenCalled();
    timer.mockRestore();
  });
});
