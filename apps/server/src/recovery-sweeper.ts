// Periyodik kurtarma süpürücüsü (docs/07 → "Açılış sırası: … → süpürücü").
//
// NEDEN VAR: kurtarma YALNIZCA açılışta koşuyordu. Yaşam döngüsü ortasında
// hata alan bir görev `verifying`/`testing` gibi bir durumda takılı kalıyor ve
// worker/verifier agent'larını tutuyordu; sıradaki görev "idle worker
// bulunamadi" ile hiç başlayamıyordu. Yani TEK bir yarım kalan iş, projeyi
// sunucu yeniden başlatılana kadar kilitliyordu.
export interface RecoverySweepPorts {
  recover(): Promise<Readonly<{ requeuedTaskIds: readonly string[]; idledAgentIds: readonly string[] }>>;
  log(message: string): void;
  onError(reason: unknown): void;
}

export const RECOVERY_SWEEP_INTERVAL_MS = 60_000;

/** Tek tur. Sessiz kalmaz: düzelttiğini de düşerse sebebini de bildirir. */
export async function sweepRecovery(ports: RecoverySweepPorts): Promise<number> {
  try {
    const result = await ports.recover();
    const repaired = result.requeuedTaskIds.length + result.idledAgentIds.length;
    if (repaired > 0) {
      ports.log(
        `kurtarma süpürücüsü: ${result.requeuedTaskIds.length} görev kuyruğa, `
        + `${result.idledAgentIds.length} agent boşa alındı`,
      );
    }
    return repaired;
  } catch (reason) {
    // Süpürücü hatası sunucuyu düşürmemeli ama görünmez de olmamalı.
    ports.onError(reason);
    return 0;
  }
}
