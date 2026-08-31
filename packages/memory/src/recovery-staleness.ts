// "Bu iş gerçekten ölü mü?" kararı.
//
// NEDEN VAR: kurtarma yalnızca heartbeat anahtarının YOKLUĞUNA bakıyordu.
// Heartbeat ancak atamadan SONRA yazılabildiği için yeni atanmış canlı bir
// agent ölü görünüyordu: süpürücü canlı görevi düşürdü, agent'ını boşa aldı ve
// dosya kilidini devraldı ("file lock renew foreign owner ile catisti").
// Bu yüzden süpürücü varsayılan olarak KAPATILDI ve o günden beri ölü koşuların
// bıraktığı agent'lar sonsuza dek 'busy' kalıyor — proje yeni iş alamıyor.
//
// Eksik olan tek şey bekleme payıydı: heartbeat yazma penceresini kapsayan bir
// süre boyunca kayıt DEĞİŞMEMİŞSE iş gerçekten ölüdür.

export interface StalenessInput {
  /** Redis'te heartbeat anahtarı yok. */
  readonly heartbeatMissing: boolean;
  /** Kaydın son değiştiği an (atama da bu alanı günceller). */
  readonly lastUpdatedAtMs: number;
  readonly nowMs: number;
  /** Heartbeat'in ilk kez yazılabilmesi için tanınan pay. */
  readonly graceMs: number;
}

/** Varsayılan pay: heartbeat TTL'inin iki katı (30 sn TTL için 60 sn). */
export const DEFAULT_RECOVERY_GRACE_MS = 60_000;

export function isRecoverableStale(input: StalenessInput): boolean {
  if (!input.heartbeatMissing) return false;
  // Bozuk zaman: kurtarma YAPILMAZ. Yanlış kurtarma canlı işi öldürür,
  // yapılmayan kurtarma yalnızca gecikir.
  if (!Number.isFinite(input.lastUpdatedAtMs) || !Number.isFinite(input.nowMs)) return false;
  if (!Number.isFinite(input.graceMs) || input.graceMs < 0) return false;
  return input.nowMs - input.lastUpdatedAtMs >= input.graceMs;
}
