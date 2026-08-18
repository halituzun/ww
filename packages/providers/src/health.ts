import { HEALTH_STATUSES } from '@ww/shared';
// Sağlayıcı sağlık durum makinesi — docs/04-model-katmani.md → Sağlık Kontrolü.
//
// Kurallar:
//   - art arda DOWN_AFTER_FAILURES ping hatası  -> down
//   - son 5 dk hata oranı DEGRADED_ERROR_RATE'i AŞARSA -> degraded
//   - başarılı ping -> ok (sayaç sıfırlanır)
// Belgede tanımlanmayan ara durum: eşiğin altındaki art arda hatalar `down`
// ilan etmek için yeterli değildir ama sağlıklı da sayılmaz; `degraded` denir.

// Tip TEK KAYNAKTAN türer: ayrı bir birlik yazmak, dizi büyüdüğünde sessizce
// ayrışırdı (panel kapsam testi diziye bakıyor).
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export const DOWN_AFTER_FAILURES = 3;
export const DEGRADED_ERROR_RATE = 0.5;

export interface HealthEvaluationInput {
  /** Bu turdaki hafif ping başarılı mı. */
  pingOk: boolean;
  /** Bu turdan ÖNCEKİ art arda hata sayısı. */
  consecutiveFailures: number;
  /** Son 5 dakikanın hata oranı (0..1), `mv_provider_errors`'tan. Bilinmiyorsa boş. */
  errorRate?: number | undefined;
}

export interface HealthEvaluation {
  status: HealthStatus;
  consecutiveFailures: number;
}

export function evaluateHealth(input: HealthEvaluationInput): HealthEvaluation {
  if (!Number.isInteger(input.consecutiveFailures) || input.consecutiveFailures < 0) {
    throw new Error('geçersiz art arda hata sayacı');
  }

  if (!input.pingOk) {
    const consecutiveFailures = input.consecutiveFailures + 1;
    return {
      status: consecutiveFailures >= DOWN_AFTER_FAILURES ? 'down' : 'degraded',
      consecutiveFailures,
    };
  }

  const degradedByErrorRate = input.errorRate !== undefined && input.errorRate > DEGRADED_ERROR_RATE;
  return { status: degradedByErrorRate ? 'degraded' : 'ok', consecutiveFailures: 0 };
}
