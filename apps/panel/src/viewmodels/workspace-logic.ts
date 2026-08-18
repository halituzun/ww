// Çalışma alanı görünümünün saf mantığı (MVVM: ViewModel katmanı).
// docs/09: View yalnız çizer; karar ve dönüşüm burada durur ve test edilir.
import type { FileIndex, Task } from '../services/projects.js';

export interface TimelineEvent {
  event: string;
  /**
   * OPAK imleç (docs/08). Eskiden `seq: number` idi ve UInt64 değerler 2^53
   * üstünde kırpılıyordu; canlı veride olayların %65'i o sınırın üstünde
   * olduğu için kırpılmış değerler EŞİTLENİYOR ve aşağıdaki tekilleştirme
   * onları "tekrar" sanıp atıyordu. Besleme bağlı görünüp ölü kalıyordu.
   */
  cursor: string;
  ts: string;
  /** Olayı üreten görev; sunucu zarfında kolon olarak gelir, payload'da değil. */
  taskId?: string;
  data: unknown;
}

/** Panelin bellekte tuttuğu olay sayısı; sınırsız birikim paneli kilitler. */
export const TIMELINE_LIMIT = 100;

export function countTaskStatuses(tasks: readonly Task[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
  }
  return counts;
}

/**
 * Dosya seçimini kararlı tutar: liste yenilendiğinde kullanıcının baktığı
 * dosya hâlâ varsa seçim korunur, yoksa ilk dosyaya düşer.
 */
export function pickSelectedFile(
  current: string | undefined,
  files: readonly FileIndex[],
): string | undefined {
  if (current !== undefined && files.some((file) => file.file_path === current)) return current;
  return files[0]?.file_path;
}

/**
 * Olayı zaman çizelgesine ekler. WebSocket yeniden bağlanınca aynı olay
 * tekrar gelebildiği için `seq` ile tekilleştirilir.
 */
export function appendTimelineEvent(
  current: readonly TimelineEvent[],
  next: TimelineEvent,
): TimelineEvent[] {
  if (current.some((event) => event.cursor === next.cursor)) return [...current];
  return [...current.slice(-(TIMELINE_LIMIT - 1)), next];
}
