import { compareCursors } from './cursor-order.js';
// Canlı olay aboneliğinin yaşam döngüsü (MVVM: ViewModel katmanı).
//
// NEDEN AYRI DOSYA: bu mantık View'ın (App.tsx) içinde bir useEffect olarak
// duruyordu — yani en kırılgan parça (yeniden bağlanma, geri çekilme, kaldığı
// yerden devam) test edilemiyordu. docs/09: "View'da iş mantığı yasak".
// Burada React ve DOM'a hiç dokunulmaz; soket ve zamanlayıcı dışarıdan verilir.
import { nextReconnectDelay, resumeCursor, type ConnectionState } from './live-connection.js';
import type { TimelineEvent } from './workspace-logic.js';

/** WebSocket'in kullandığımız yüzeyi; testte sahtelenebilsin diye daraltıldı. */
export interface LiveSocket {
  onopen: (() => void) | undefined;
  onmessage: ((message: { data: string }) => void) | undefined;
  onclose: (() => void) | undefined;
  onerror: (() => void) | undefined;
  send(payload: string): void;
  close(): void;
}

export interface LiveSubscriptionInput {
  readonly url: string;
  readonly projectId: string;
  /** Devam imleci bunlardan hesaplanır; baştan akıtmak çift kayıt üretir. */
  readonly initialEvents: readonly TimelineEvent[];
  createSocket(url: string): LiveSocket;
  setTimer(fn: () => void, delay: number): number;
  clearTimer(handle: number): void;
  onState(state: ConnectionState): void;
  onEvent(event: TimelineEvent): void;
}

/** Aboneliği başlatır; dönen fonksiyon onu kalıcı olarak durdurur. */
export function createLiveEventSubscription(input: LiveSubscriptionInput): () => void {
  let active = true;
  let socket: LiveSocket | undefined;
  let timer: number | undefined;
  let attempt = 0;
  // İlk olaylardan BESLENİR: sıfırdan başlamak tüm geçmişi yeniden akıtır
  // ve zaman çizelgesini çift kayıtla doldurur.
  // İlk olaylardan BESLENİR: sıfırdan başlamak tüm geçmişi yeniden akıtır.
  let cursor = resumeCursor(input.initialEvents);

  const retry = (): void => {
    if (!active) return;
    input.onState('retrying');
    timer = input.setTimer(connect, nextReconnectDelay(attempt));
    attempt += 1;
  };

  function connect(): void {
    if (!active) return;
    input.onState(attempt === 0 ? 'connecting' : 'retrying');
    let opened: LiveSocket;
    try {
      opened = input.createSocket(input.url);
    } catch {
      // Soket hiç kurulamadıysa bile sessizce ölmemeli: yeniden denenir.
      retry();
      return;
    }
    socket = opened;

    opened.onopen = () => {
      if (!active) return;
      // Sayaç sıfırlanmazsa panel bir kez kopunca kalıcı olarak yavaşlar.
      attempt = 0;
      input.onState('open');
      opened.send(JSON.stringify({
        event: 'subscribe',
        // BigInt JSON'a doğrudan konamaz; imleç zaten METİN olarak taşınır
        // (docs/08: opak imleç).
        data: { projectId: input.projectId, afterCursor: cursor },
      }));
    };

    opened.onmessage = (message) => {
      if (!active) return;
      let next: TimelineEvent;
      try {
        next = JSON.parse(message.data) as TimelineEvent;
      } catch {
        // Tek bozuk çerçeve tüm beslemeyi düşürmemeli.
        return;
      }
      // ABONELİK REDDİ OLAY DEĞİLDİR. Sunucu geçersiz proje kimliği ya da
      // bozuk imleç yüzünden aboneliği reddettiğinde soket AÇIK kalır; bunu
      // olay sayıp "Canlı" göstermek, hiç veri gelmeyen bir paneli sağlıklı
      // gibi sunar. Durum düşürülür, kullanıcı bağlantının çalışmadığını görür.
      if (next.event === 'subscribe.rejected') {
        input.onState('offline');
        return;
      }
      if (typeof next.cursor === 'string' && compareCursors(next.cursor, cursor) > 0) {
        cursor = next.cursor;
      }
      input.onEvent(next);
    };

    opened.onclose = retry;
    opened.onerror = () => opened.close();
  }

  connect();

  return () => {
    active = false;
    if (timer !== undefined) input.clearTimer(timer);
    socket?.close();
    input.onState('offline');
  };
}
