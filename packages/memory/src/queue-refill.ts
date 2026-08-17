// Kuyruk yeniden doldurma planı (docs/07 → Kurtarma, adım 3).
//
// NEDEN VAR: ClickHouse'da `queued` duran ama Redis stream'inde karşılığı
// olmayan görev SONSUZA DEK bekler — kuyruğu tüketen kimse onu görmez.
// Bu, Redis silindiğinde/temizlendiğinde ya da stream budandığında gerçekten
// oluyor. RecoveryService yalnızca TAKILI görevleri (assigned/working…) geri
// kuyruğa düşürüyordu; zaten `queued` olanlar kör noktaydı.
export function planQueueRefill(
  queuedTaskIds: readonly string[],
  streamTaskIds: readonly string[],
): readonly string[] {
  const present = new Set(streamTaskIds);
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const taskId of queuedTaskIds) {
    if (present.has(taskId)) continue;
    // Aynı görevi iki kez eklemek onu iki kez çalıştırmayı dener.
    if (seen.has(taskId)) continue;
    seen.add(taskId);
    missing.push(taskId);
  }
  return Object.freeze(missing);
}
