// Görevin ÇALIŞMADAN, kullanıcı cevabı bekleyerek geçirdiği süre.
//
// NEDEN VAR: duvar saati freni görevin created_at'inden itibaren ölçüyordu,
// yani kullanıcının cevap vermesini beklediği saatler de "iş süresi" sayılıyordu.
// docs/07 bu freni "sonsuz sürünme önleme" diye tanımlar. Bekleme sayılınca
// soru soran her görev, kullanıcı tavandan geç cevap verdiğinde cevabın hemen
// ardından fren yiyip tırmandırılıyordu — canlı satranç koşusunda tam olarak
// bu oldu ve az önce çalışır hale getirilen cevap akışını işe yaramaz kılıyordu.

/** Görevin bir sürüm satırı: hangi durumda, ne zaman. */
export interface TaskStatusPoint {
  readonly status: string;
  readonly atMs: number;
}

/** Kullanıcı girdisi beklenen, yani iş YAPILMAYAN durumlar. */
const WAITING_STATUSES: ReadonlySet<string> = new Set(['waiting_user', 'awaiting_user']);

/**
 * Sürüm noktaları sıraya konur; bekleme durumundaki her nokta, bir sonraki
 * noktaya (yoksa `nowMs`'e) kadar geçen süreyi duraklama sayar.
 *
 * Bozuk zaman damgaları ve geriye giden aralıklar YOK SAYILIR: eksik ölçüm
 * freni gevşetmeli değil, sıkı bırakmalıdır.
 */
export function pausedWaitingMs(
  points: readonly TaskStatusPoint[],
  nowMs: number,
): number {
  if (!Number.isFinite(nowMs)) return 0;
  const ordered = points
    .filter((point) => Number.isFinite(point.atMs))
    .slice()
    .sort((left, right) => left.atMs - right.atMs);

  let paused = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const point = ordered[index]!;
    if (!WAITING_STATUSES.has(point.status)) continue;
    const until = ordered[index + 1]?.atMs ?? nowMs;
    const span = until - point.atMs;
    if (span > 0) paused += span;
  }
  return paused;
}
