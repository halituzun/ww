// Görev durumlarının Türkçe karşılıkları (karar K6: "Panel dili Türkçe,
// agent içi İngilizce").
//
// NEDEN VAR: panel durumları HAM İNGİLİZCE kimlik olarak basıyordu
// (`queued`, `waiting_user`). Bu, anlatıcının ham olay adı basmasıyla aynı
// kusur: iç tanımlayıcı kullanıcı yüzeyine sızıyor.
const LABELS: Readonly<Record<string, string>> = Object.freeze({
  queued: "kuyrukta",
  assigned: "atandı",
  working: "çalışıyor",
  verifying: "doğrulanıyor",
  testing: "kapıda",
  approved: "onaylandı",
  rejected: "reddedildi",
  done: "bitti",
  failed: "düştü",
  cancelled: "iptal edildi",
  escalated: "tırmandırıldı",
  waiting_user: "cevap bekliyor",
});

/**
 * ClickHouse tasks şeması ve @ww/shared ile hizalı çalışan görev durumları.
 * "running" ve "active" görev durumu DEĞİLDİR (proje durumudur).
 */
export const RUNNING_TASK_STATUSES: ReadonlySet<string> = new Set([
  "assigned",
  "working",
  "verifying",
  "testing",
  "approved",
]);

export function isTaskRunning(status: string): boolean {
  return RUNNING_TASK_STATUSES.has(status);
}

export function isTaskDone(status: string): boolean {
  return status === "done";
}

/**
 * Bilinmeyen durumda ad KORUNUR, uydurulmaz: anlamadığı bir durumu
 * Türkçeleştirmek kullanıcıya olmayan bir anlam verir.
 */
export function taskStatusLabel(status: string): string {
  return LABELS[status] ?? status;
}
