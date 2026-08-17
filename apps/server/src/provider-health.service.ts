// Periyodik sağlayıcı sağlık kontrolü — docs/04-model-katmani.md → Sağlık Kontrolü.
// Adaptörlerde healthCheck() vardı ama onu çağıran hiçbir şey yoktu; bu yüzden tüm
// sağlayıcılar 'unknown' kalıyor ve fallback zincirinin sağlık sinyali ölüydü.
import { evaluateHealth, type HealthStatus } from '@ww/providers';
import type { ApiProviderRow, UpsertApiProviderInput } from '@ww/db';

export interface PingResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  /**
   * Kalıcı yapılandırma eksikliği (ör. anahtar yok). Ağ dalgalanması değildir;
   * art arda hata yumuşatmasına tabi tutulmadan doğrudan `down` yazılır.
   */
  fatal?: boolean;
}

/** docs/04: periyodik ping api_usage'a purpose='health_check' olarak yazılır. */
export interface HealthUsageRecord {
  providerId: string;
  purpose: 'health_check';
  status: 'ok' | 'error';
  latencyMs: number;
  errorKind: string;
  checkedAt: string;
}

export interface HealthChangeEvent {
  providerId: string;
  status: HealthStatus;
  previousStatus: string;
  latencyMs: number;
  checkedAt: string;
}

export interface HealthSweepPorts {
  listProviders: () => Promise<readonly ApiProviderRow[]>;
  /** 1 token'lık hafif ping (purpose='health_check'). */
  ping: (providerId: string) => Promise<PingResult>;
  /** Son 5 dk hata oranı (0..1) — mv_provider_errors. Bilinmiyorsa undefined. */
  errorRate: (providerId: string) => Promise<number | undefined>;
  persist: (row: UpsertApiProviderInput) => Promise<unknown>;
  /**
   * Ping'i api_usage'a yazar. Kayıt yoksa iki sinyal birden kaybolur:
   * kontör panosunda ping maliyeti ve mv_provider_errors'tan beslenen
   * hata-oranı (yani `degraded` yolu hiç tetiklenmez).
   */
  recordUsage?: ((record: HealthUsageRecord) => Promise<unknown>) | undefined;
  /** Tek sağlayıcının hatası taramayı düşürmez ama sessizce kaybolmaz. */
  onError?: ((providerId: string, reason: unknown) => void) | undefined;
  publish: (event: HealthChangeEvent) => Promise<unknown>;
  now: () => string;
}

/** Sağlayıcı başına art arda hata sayacı; tur boyunca taşınır. */
export type FailureCounters = ReadonlyMap<string, number>;

export const HEALTH_SWEEP_INTERVAL_MS = 60_000;

// Pasif sağlayıcı hiç kontrol edilmez. Anahtarsız olan ATLANMAZ: yapılandırma
// eksikliği de bir sağlık sorunudur ve panelde 'unknown' değil 'down' görünmelidir.
const isCheckable = (provider: ApiProviderRow): boolean => provider.enabled;

export async function runHealthSweep(
  ports: HealthSweepPorts,
  counters: FailureCounters,
): Promise<Map<string, number>> {
  const next = new Map(counters);
  const providers = await ports.listProviders();

  for (const provider of providers) {
    if (!isCheckable(provider)) continue;

    try {
      const ping = await ports.ping(provider.provider_id);
      const pingedAt = ports.now();

      // Durum değişmese bile ping YAPILDI; kaydı düşmek hata oranını çarpıtır.
      // Kayıt hatası taramayı düşürmemeli: sağlık durumu yine yazılmalı.
      if (ports.recordUsage !== undefined) {
        try {
          await ports.recordUsage({
            providerId: provider.provider_id,
            purpose: 'health_check',
            status: ping.ok ? 'ok' : 'error',
            latencyMs: ping.latencyMs,
            errorKind: ping.ok ? '' : (ping.error ?? 'unknown'),
            checkedAt: pingedAt,
          });
        } catch (reason) {
          ports.onError?.(provider.provider_id, reason);
        }
      }

      const errorRate = await ports.errorRate(provider.provider_id);
      const evaluation = ping.fatal === true
        ? { status: 'down' as const, consecutiveFailures: next.get(provider.provider_id) ?? 0 }
        : evaluateHealth({
            pingOk: ping.ok,
            consecutiveFailures: next.get(provider.provider_id) ?? 0,
            errorRate,
          });
      next.set(provider.provider_id, evaluation.consecutiveFailures);

      if (evaluation.status === provider.health_status) continue; // gürültü yazma

      const checkedAt = ports.now();
      await ports.persist({
        provider_id: provider.provider_id,
        display_name: provider.display_name,
        base_url: provider.base_url,
        enabled: provider.enabled,
        is_default: provider.is_default,
        fallback_order: provider.fallback_order,
        models: provider.models,
        key_ref: provider.key_ref,
        health_status: evaluation.status,
        last_health_check: checkedAt,
        updated_at: checkedAt,
      });
      await ports.publish({
        providerId: provider.provider_id,
        status: evaluation.status,
        previousStatus: provider.health_status,
        latencyMs: ping.latencyMs,
        checkedAt,
      });
    } catch (reason) {
      // Bir sağlayıcının adaptör/ağ hatası taramanın kalanını düşürmemeli,
      // ama sessizce de kaybolmamalı (aksi halde programlama hataları gizlenir).
      ports.onError?.(provider.provider_id, reason);
      continue;
    }
  }

  return next;
}
