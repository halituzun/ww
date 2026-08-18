// Zaman çizelgesi yeniden oynatma (docs/08 → tuval zaman çizelgesi modu;
// docs/11 Faz 5 → "geçmişe kaydırıcıyla dönülür").
//
// NEDEN VAR: panelin zaman çizelgesi yalnızca CANLI bir olay listesiydi ve
// tuval hep ŞİMDİKİ görev durumlarını çiziyordu. Geçmişe dönmek mümkün
// değildi; kabul kriterinin bu adımı kullanıcı katmanında hiç yoktu.
//
// Yeniden oynatma UYDURMAZ: bir görevin geçmişteki durumu yalnızca o ana
// kadarki `status_change` olaylarından türetilir. Olay yoksa durum
// "bilinmiyor"dur — şimdiki durumu geçmişe yazmak, olmayan bir geçmiş
// uydurmak olurdu.

import { compareCursors } from './cursor-order.js';
export interface ReplayEvent {
  readonly event: string;
  readonly cursor: string;
  readonly ts: string;
  /** Sunucu zarfındaki görev kimliği; `events.task_id` KOLONUNDAN gelir. */
  readonly taskId?: string | undefined;
  readonly data: unknown;
}

export interface ReplayState {
  /** Kaydırıcının durduğu ana kadarki olaylar (eski → yeni). */
  readonly visible: readonly ReplayEvent[];
  /** O andaki görev durumları; yalnızca olaydan türetilenler. */
  readonly statusByTask: ReadonlyMap<string, string>;
  readonly at: ReplayEvent | undefined;
}

const readString = (source: unknown, key: string): string | undefined => {
  if (typeof source !== 'object' || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

/** Olayları seq'e göre sıralar; canlı akış sırasız gelebilir. */
export function orderedEvents(events: readonly ReplayEvent[]): readonly ReplayEvent[] {
  // Sayısal fark YETMEZ: imleçler 2^53'ü aşar ve Number'a çevirmek sıralamayı
  // bozar (bkz. cursor-order.ts).
  return [...events].sort((left, right) => compareCursors(left.cursor, right.cursor));
}

/**
 * `cursor`: kaçıncı olaya kadar oynatılacağı (1 tabanlı sayı).
 * 0 ya da altı "hiç olay yok", uzunluktan büyük olan "sonuna kadar" demektir.
 */
export function replayAt(
  events: readonly ReplayEvent[],
  cursor: number,
): ReplayState {
  const ordered = orderedEvents(events);
  const safeCursor = Number.isFinite(cursor)
    ? Math.max(0, Math.min(Math.trunc(cursor), ordered.length))
    : ordered.length;
  const visible = ordered.slice(0, safeCursor);

  const statusByTask = new Map<string, string>();
  for (const event of visible) {
    if (event.event !== 'status_change') continue;
    // Görev kimliği ZARFTAN okunur: payload'da yoktur (kolondur). Yalnızca
    // payload'a bakmak her görevi "bilinmiyor" gösterirdi.
    const taskId = (event.taskId !== undefined && event.taskId !== '' ? event.taskId : undefined)
      ?? readString(event.data, 'taskId') ?? readString(event.data, 'task_id');
    const status = readString(event.data, 'status') ?? readString(event.data, 'toStatus');
    if (taskId === undefined || status === undefined) continue;
    statusByTask.set(taskId, status);
  }

  return Object.freeze({
    visible,
    statusByTask,
    at: visible[visible.length - 1],
  });
}
