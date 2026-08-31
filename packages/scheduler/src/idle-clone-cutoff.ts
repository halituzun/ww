// docs/03 Klonlama: "Boşta kalan klonlar 10 dk sonra `stopped` yapılır
// (kayıt silinmez — tarih kalır)."
//
// NEDEN VAR: `stopIdleClones` yazılmıştı ama HİÇ ÇAĞRILMIYORDU (ne üretimde
// ne testte). Klonlar sonsuza dek birikiyor; `max_clones_per_agent` (5) ve
// `max_parallel_agents` (8) sınırlarına dayanınca klonlama sessizce durur ve
// görevler "idle worker/verifier bulunamadi" ile ertelenmeye başlar. Yani
// kaynak koruması, kendisini korumasız bırakıyordu.

export const IDLE_CLONE_TTL_MS = 10 * 60_000;

/**
 * Bu andan ÖNCE boşta duran klonlar durdurulur.
 *
 * Geçersiz saatte `undefined` döner: sessizce "şimdi" saymak HER klonu
 * durdururdu — az önce açılanı bile. Süpürme, kendi girdisine
 * güvenemediğinde hiçbir şeyi durdurmamalı.
 */
export function idleCloneCutoff(now: string, ttlMs: number = IDLE_CLONE_TTL_MS): string | undefined {
  const parsed = Date.parse(now);
  if (!Number.isFinite(parsed)) return undefined;
  const ttl = Number.isSafeInteger(ttlMs) && ttlMs > 0 ? ttlMs : IDLE_CLONE_TTL_MS;
  return new Date(parsed - ttl).toISOString();
}
