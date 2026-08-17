import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { NIL_UUID } from '@ww/shared';
import { getLatestApiProvider, listLatestApiProviders, upsertApiProvider } from '@ww/db';
import { Keystore, buildProviderRegistry } from '@ww/providers';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';
import {
  HEALTH_SWEEP_INTERVAL_MS,
  runHealthSweep,
  type HealthChangeEvent,
  type HealthSweepPorts,
  type HealthUsageRecord,
  type PingResult,
} from './provider-health.service.js';

// docs/04 → Sağlık Kontrolü: 60 sn'de bir hafif ping + son 5 dk hata oranı.
// Ping artık gerçek adaptör üzerinden yapılır (LlmProvider.healthCheck, 1 token).
// Anahtarı olmayan sağlayıcı kalıcı yapılandırma eksikliğidir: fatal sayılıp
// doğrudan 'down' yazılır, art arda hata yumuşatmasına tabi tutulmaz.
@Injectable()
export class ProviderHealthScheduler implements OnModuleInit, OnModuleDestroy {
  readonly #logger = new Logger(ProviderHealthScheduler.name);
  readonly #database: ServerDatabase;
  #timer: ReturnType<typeof setInterval> | undefined;
  #counters = new Map<string, number>();

  constructor(@Inject(SERVER_DATABASE) database: ServerDatabase) {
    this.#database = database;
  }

  onModuleInit(): void {
    if (process.env['WW_DISABLE_HEALTH_SWEEP'] === '1') return;
    this.#timer = setInterval(() => { void this.sweep(); }, HEALTH_SWEEP_INTERVAL_MS);
    this.#timer.unref?.();
    void this.sweep();
  }

  onModuleDestroy(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async sweep(): Promise<void> {
    try {
      this.#counters = await runHealthSweep(this.#ports(), this.#counters);
    } catch (reason) {
      this.#logger.warn(`sağlık taraması başarısız: ${String(reason)}`);
    }
  }

  #ports(): HealthSweepPorts {
    const ch = this.#database.ch;
    return {
      listProviders: () => listLatestApiProviders(ch),
      ping: (providerId) => this.#pingProvider(providerId),
      errorRate: (providerId) => this.#recentErrorRate(providerId),
      persist: (row) => upsertApiProvider(ch, row),
      recordUsage: (record) => this.#recordUsage(record),
      publish: (event) => this.#publish(event),
      onError: (providerId, reason) =>
        this.#logger.warn(`sağlayıcı ${providerId} kontrol edilemedi: ${String(reason)}`),
      now: () => new Date().toISOString(),
    };
  }

  // Anahtarı/yapılandırması olmayan sağlayıcı "down" sayılır: eksik kurulum da
  // bir sağlık sorunudur ve panelde görünmelidir.
  async #pingProvider(providerId: string): Promise<PingResult> {
    const started = Date.now();
    const record = await getLatestApiProvider(this.#database.ch, providerId);
    if (record === null) {
      return { ok: false, latencyMs: Date.now() - started, error: 'kayıt yok', fatal: true };
    }

    const store = await Keystore.open(
      process.env['WW_KEYSTORE_FILE'] ?? `${process.cwd()}/.ww/keys.json`,
    );
    const registry = await buildProviderRegistry([record], store);
    const provider = registry.providers.get(providerId);
    if (provider === undefined) {
      const skipped = registry.skipped.find((entry) => entry.providerId === providerId);
      return {
        ok: false, latencyMs: Date.now() - started,
        error: skipped?.reason ?? 'adaptör kurulamadı', fatal: true,
      };
    }

    // Gerçek 1 token'lık ping (docs/04). Ağ hatası fatal DEĞİLDİR: geçici
    // olabilir, art arda üç hatadan sonra 'down' olur.
    const health = await provider.healthCheck();
    return health.ok
      ? { ok: true, latencyMs: health.latencyMs }
      : { ok: false, latencyMs: health.latencyMs, error: health.error ?? 'ping başarısız' };
  }

  // docs/04: ping api_usage'a purpose='health_check' olarak yazılır. Bu kayıt
  // mv_provider_errors'ı besler; hata-oranı sinyali oradan gelir.
  async #recordUsage(record: HealthUsageRecord): Promise<void> {
    await this.#database.ch.insert({
      table: 'api_usage',
      values: [{
        usage_id: randomUUID(),
        project_id: NIL_UUID,
        agent_id: NIL_UUID,
        task_id: NIL_UUID,
        provider_id: record.providerId,
        model: '',
        purpose: record.purpose,
        prompt_tokens: 0,
        completion_tokens: 0,
        // Sağlık ping'i 1 token'lıktır; maliyeti ölçülebilir değil, 0 yazılır.
        cost_usd: 0,
        latency_ms: record.latencyMs,
        status: record.status,
        error_kind: record.errorKind,
        created_at: record.checkedAt,
      }],
      format: 'JSONEachRow',
    });
  }

  async #recentErrorRate(providerId: string): Promise<number | undefined> {
    const result = await this.#database.ch.query({
      query: `SELECT sum(errors) AS errors, sum(total) AS total
        FROM mv_provider_errors
        WHERE provider_id = {providerId:String} AND minute >= now() - INTERVAL 5 MINUTE`,
      query_params: { providerId },
      format: 'JSONEachRow',
    });
    const rows = await result.json<{ errors: string | number; total: string | number }>();
    const row = rows[0];
    if (!row) return undefined;
    const total = Number(row.total);
    if (!Number.isFinite(total) || total === 0) return undefined;
    return Number(row.errors) / total;
  }

  async #publish(event: HealthChangeEvent): Promise<void> {
    this.#logger.log(`sağlayıcı ${event.providerId}: ${event.previousStatus} → ${event.status}`);
  }
}
