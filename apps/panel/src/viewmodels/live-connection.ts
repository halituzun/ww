import { highestCursor } from './cursor-order.js';
// Canlı bağlantının dayanıklılık mantığı (MVVM: ViewModel katmanı).
//
// Panel WebSocket'i açıyor ama onclose/onerror dinlemiyordu: bağlantı
// koptuğunda (server yeniden başlaması, uyku, ağ titremesi) canlı besleme
// SESSİZCE ölüyor, kullanıcı sayfayı yenileyene dek donmuş veri görüyordu.
import type { TimelineEvent } from './workspace-logic.js';

export type ConnectionState = 'connecting' | 'open' | 'retrying' | 'offline';

const BASE_RECONNECT_DELAY_MS = 500;
export const MAX_RECONNECT_DELAY_MS = 15_000;

/** Üstel geri çekilme; üst sınır olmadan sunucu döndüğünde panel dakikalarca ölü kalır. */
export function nextReconnectDelay(attempt: number): number {
  const safe = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * 2 ** safe);
}

/**
 * Yeniden bağlanmada nereden devam edileceği. 0'dan başlamak tüm geçmişi
 * tekrar akıtır ve zaman çizelgesini çift kayıtla doldurur.
 */
export function resumeCursor(events: readonly TimelineEvent[]): string {
  // İmleç OPAKTIR; sunucu sözlük sırası = zaman sırası olacak şekilde kodlar.
  return highestCursor(events.map((event) => event.cursor));
}

export function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case 'open': return 'Canlı';
    case 'connecting': return 'Bağlanıyor…';
    case 'retrying': return 'Yeniden bağlanıyor…';
    default: return 'Bağlantı yok';
  }
}
