/**
 * Orkestrasyon runtime'ının açık olup olmadığını raporlar.
 *
 * NEDEN VAR: `registerPhase9RuntimeConfig` hiçbir üretim kodundan çağrılmıyor ve
 * `WW_PHASE8_RUNTIME_ENABLED` hiçbir yerde ayarlanmıyor. Sonuç: server REST,
 * WebSocket, migration, recovery ve sağlık taramasını koşuyor ama görev
 * kuyruğunu tüketen kimse yok — panelden açılan bir projenin görevleri sonsuza
 * dek `queued` kalır.
 *
 * Bu sessiz devre dışılık en tehlikeli türden: /health yeşil, loglar temiz,
 * sistem çalışıyor görünüyor. Bu modül durumu açıkça yüzeye çıkarır.
 */
export type OrchestrationState = 'enabled' | 'disabled' | 'misconfigured';

export interface RuntimeStatus {
  orchestration: OrchestrationState;
  /** Görevler fiilen işlenecek mi. */
  tasksProcessed: boolean;
  /** Devre dışıysa nedeni; etkinse boş. */
  reason: string;
}

export const RUNTIME_FLAG = 'WW_PHASE8_RUNTIME_ENABLED';

export function runtimeStatus(readConfig: () => unknown): RuntimeStatus {
  const enabled = process.env[RUNTIME_FLAG] === '1';

  if (!enabled) {
    return {
      orchestration: 'disabled',
      tasksProcessed: false,
      reason: `${RUNTIME_FLAG}=1 ayarlı değil — görev kuyruğunu tüketen orkestrasyon runtime'ı başlatılmıyor, görevler 'queued' durumunda bekler.`,
    };
  }

  if (readConfig() === null || readConfig() === undefined) {
    return {
      orchestration: 'misconfigured',
      tasksProcessed: false,
      reason: `${RUNTIME_FLAG}=1 ancak Phase9RuntimeConfig kaydı yok; registerPhase9RuntimeConfig çağrılmamış.`,
    };
  }

  return { orchestration: 'enabled', tasksProcessed: true, reason: '' };
}
