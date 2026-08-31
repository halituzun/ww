// Çalışan işin canlılık işareti.
//
// NEDEN VAR: kurtarma, takılı işi heartbeat'in YOKLUĞUNDAN anlar. Ama
// `setHeartbeat` hiçbir üretim kodundan çağrılmıyordu; bu yüzden ÇALIŞAN bir
// görev bile "ölü" görünüyordu. Periyodik süpürücü eklenince bu doğrudan
// zarara dönüştü: aktif görevin dosya kilidi devralınıp iş
// "file lock renew foreign owner ile catisti" ile düşüyordu.
export interface HeartbeatPorts {
  beat(): Promise<void>;
  setTimer(fn: () => void, delayMs: number): number;
  clearTimer(handle: number): void;
  onError(reason: unknown): void;
}

/** Model çağrısı TTL'den uzun sürebilir; bu yüzden yenileme aralığı TTL'in altında. */
export const HEARTBEAT_REFRESH_MS = 10_000;

/**
 * `run` boyunca canlılık işaretini tazeler ve bitince durdurur. Heartbeat
 * hatası işi düşürmez: canlılık işareti kaybı en fazla kurtarmayı tetikler,
 * ama işin kendisini iptal etmek daha kötüdür.
 */
export async function withHeartbeat<T>(
  ports: HeartbeatPorts,
  run: () => Promise<T>,
): Promise<T> {
  const beat = () => { ports.beat().catch((reason) => ports.onError(reason)); };
  beat();
  const handle = ports.setTimer(beat, HEARTBEAT_REFRESH_MS);
  try {
    return await run();
  } finally {
    ports.clearTimer(handle);
  }
}
