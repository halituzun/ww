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

export interface ReplayEvent {
  readonly event: string;
  readonly seq: number;
  readonly ts: string;
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
  return [...events].sort((left, right) => left.seq - right.seq);
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
    const taskId = readString(event.data, 'taskId') ?? readString(event.data, 'task_id');
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
