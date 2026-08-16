import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { listLatestApiProviders, upsertApiProvider } from '@ww/db';
import { Keystore } from '@ww/providers';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';
import {
  HEALTH_SWEEP_INTERVAL_MS,
  runHealthSweep,
  type HealthChangeEvent,
  type HealthSweepPorts,
  type PingResult,
} from './provider-health.service.js';

// docs/04 → Sağlık Kontrolü: 60 sn'de bir hafif ping + son 5 dk hata oranı.
// Ping'in kendisi henüz gerçek LLM çağrısı yapmaz; anahtarın varlığı ve
// mv_provider_errors sinyali kullanılır. Gerçek ping, sağlayıcı adaptörleri
// runtime'a bağlandığında `pingProvider` içinden yapılacaktır.
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
      publish: (event) => this.#publish(event),
      onError: (providerId, reason) =>
        this.#logger.warn(`sağlayıcı ${providerId} kontrol edilemedi: ${String(reason)}`),
      now: () => new Date().toISOString(),
    };
  }

  // Anahtar deposunda karşılığı olmayan sağlayıcı "down" sayılır: yapılandırma
  // eksikliği de bir sağlık sorunudur ve panelde görünmelidir.
  async #pingProvider(providerId: string): Promise<PingResult> {
    const started = Date.now();
    const store = await Keystore.open(
      process.env['WW_KEYSTORE_FILE'] ?? `${process.cwd()}/.ww/keys.json`,
    );
    const key = await store.get(providerId);
    return key === undefined || key.length === 0
      ? { ok: false, latencyMs: Date.now() - started, error: 'anahtar yok', fatal: true }
      : { ok: true, latencyMs: Date.now() - started };
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
