import { describe, expect, it, vi } from 'vitest';
import { createLiveEventSubscription, type LiveSocket } from './live-subscription.js';
import type { TimelineEvent } from './workspace-logic.js';

const event = (seq: number): TimelineEvent =>
  ({ event: 'task_changed', cursor: `2026-08-18 09:00:${String(seq).padStart(2, '0')}.000|id`, ts: '2026-08-17T09:00:00Z', data: null });

class FakeSocket implements LiveSocket {
  onopen: (() => void) | undefined;
  onmessage: ((message: { data: string }) => void) | undefined;
  onclose: (() => void) | undefined;
  onerror: (() => void) | undefined;
  readonly sent: string[] = [];
  closed = false;
  send(payload: string): void { this.sent.push(payload); }
  close(): void { this.closed = true; this.onclose?.(); }
}

const harness = (initial: readonly TimelineEvent[] = []) => {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ fn: () => void; delay: number }> = [];
  const states: string[] = [];
  const received: TimelineEvent[] = [];
  const stop = createLiveEventSubscription({
    url: 'ws://x/events',
    projectId: 'p1',
    initialEvents: initial,
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    setTimer: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    clearTimer: () => undefined,
    onState: (state) => states.push(state),
    onEvent: (next) => { received.push(next); },
  });
  return { sockets, timers, states, received, stop };
};

describe('createLiveEventSubscription', () => {
  it('açılışta proje aboneliğini gönderir', () => {
    const { sockets } = harness();
    sockets[0]!.onopen?.();
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({
      event: 'subscribe', data: { projectId: 'p1', afterCursor: '' },
    });
  });

  // 0'dan devam etmek tüm geçmişi tekrar akıtır ve zaman çizelgesini çiftler.
  it('görülen en yüksek imleçten devam eder', () => {
    const { sockets } = harness([event(4), event(11), event(7)]);
    sockets[0]!.onopen?.();
    expect(JSON.parse(sockets[0]!.sent[0]!).data.afterCursor).toBe('2026-08-18 09:00:11.000|id');
  });

  it('gelen olayları iletir', () => {
    const { sockets, received } = harness();
    sockets[0]!.onmessage?.({ data: JSON.stringify(event(1)) });
    expect(received).toHaveLength(1);
    expect(received[0]!.cursor).toBe('2026-08-18 09:00:01.000|id');
  });

  // Bozuk bir çerçeve tüm canlı beslemeyi düşürmemeli.
  it('bozuk çerçeveyi yok sayar ve akmaya devam eder', () => {
    const { sockets, received } = harness();
    sockets[0]!.onmessage?.({ data: '{bozuk' });
    sockets[0]!.onmessage?.({ data: JSON.stringify(event(2)) });
    expect(received.map((item) => item.cursor)).toEqual(['2026-08-18 09:00:02.000|id']);
  });

  // Asıl kusur buydu: kopan bağlantı sessizce ölüyordu.
  it('kopunca yeniden bağlanmayı zamanlar', () => {
    const { sockets, timers, states } = harness();
    sockets[0]!.onclose?.();
    expect(timers).toHaveLength(1);
    expect(states).toContain('retrying');
    timers[0]!.fn();
    expect(sockets).toHaveLength(2);
  });

  it('art arda kopuşlarda gecikmeyi büyütür', () => {
    const { sockets, timers } = harness();
    sockets[0]!.onclose?.();
    timers[0]!.fn();
    sockets[1]!.onclose?.();
    expect(timers[1]!.delay).toBeGreaterThan(timers[0]!.delay);
  });

  // Yeniden bağlanınca sayaç sıfırlanmazsa panel kalıcı olarak yavaşlar.
  it('başarılı bağlantı geri çekilme sayacını sıfırlar', () => {
    const { sockets, timers } = harness();
    sockets[0]!.onclose?.();
    timers[0]!.fn();
    sockets[1]!.onopen?.();
    sockets[1]!.onclose?.();
    expect(timers[1]!.delay).toBe(timers[0]!.delay);
  });

  it('yeniden bağlanınca kaldığı imleçten devam eder', () => {
    const { sockets, timers } = harness();
    sockets[0]!.onmessage?.({ data: JSON.stringify(event(9)) });
    sockets[0]!.onclose?.();
    timers[0]!.fn();
    sockets[1]!.onopen?.();
    expect(JSON.parse(sockets[1]!.sent[0]!).data.afterCursor).toBe('2026-08-18 09:00:09.000|id');
  });

  it('durdurulunca soketi kapatır ve yeniden bağlanmaz', () => {
    const { sockets, timers, stop, states } = harness();
    stop();
    expect(sockets[0]!.closed).toBe(true);
    expect(states.at(-1)).toBe('offline');
    for (const timer of timers) timer.fn();
    expect(sockets).toHaveLength(1);
  });

  // Durdurulmuş abonelik hâlâ olay yazarsa React'te sızıntı ve hayalet güncelleme olur.
  it('durdurulduktan sonra olay iletmez', () => {
    const { sockets, stop, received } = harness();
    stop();
    sockets[0]!.onmessage?.({ data: JSON.stringify(event(3)) });
    expect(received).toHaveLength(0);
  });

  it('hata durumunda soketi kapatarak yeniden bağlanmayı tetikler', () => {
    const { sockets } = harness();
    sockets[0]!.onerror?.();
    expect(sockets[0]!.closed).toBe(true);
  });

  it('ilk denemede connecting, sonrakilerde retrying bildirir', () => {
    const { sockets, timers, states } = harness();
    expect(states[0]).toBe('connecting');
    sockets[0]!.onopen?.();
    expect(states).toContain('open');
    sockets[0]!.onclose?.();
    timers[0]!.fn();
    expect(states.at(-1)).toBe('retrying');
  });

  it('WebSocket kurulamıyorsa sessizce çökmez', () => {
    expect(() => createLiveEventSubscription({
      url: 'ws://x/events', projectId: 'p1', initialEvents: [],
      createSocket: () => { throw new Error('WebSocket yok'); },
      setTimer: () => 1, clearTimer: () => undefined,
      onState: () => undefined, onEvent: () => undefined,
    })).not.toThrow();
  });

  // ASIL KUSUR: sunucu aboneliği reddettiğinde (geçersiz proje kimliği, bozuk
  // imleç) istemciye hiçbir şey dönmüyordu; panel soketi açık gördüğü için
  // "Canlı" yazıyor ama tek bir olay bile gelmiyordu. Sunucu artık RET
  // bildiriyor; panel de onu OLAY SANMAMALI ve durumu düzeltmelidir.
  it('abonelik reddini olay saymaz ve baglantiyi canli gostermez', () => {
    const { sockets, states, received } = harness();
    sockets[0]!.onopen?.();
    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        event: 'subscribe.rejected', projectId: '', taskId: '',
        cursor: '', ts: '2026-08-18T00:00:00.000Z',
        data: { reason: 'gecersiz proje kimligi' },
      }),
    });

    expect(received).toHaveLength(0);
    expect(states.at(-1)).toBe('offline');
  });
});

const vitestUnused = vi;
void vitestUnused;
