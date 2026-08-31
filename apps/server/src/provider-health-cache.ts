// Sağlayıcı sağlığının SENKRON okunabilir görüntüsü.
//
// NEDEN VAR: docs/04 `health_status='down'`ı fallback tetikleyicisi sayar ama
// yönlendiricinin zincir kararı senkrondur ve ClickHouse okuması değildir.
// Sağlık kaydı yazılıyor, panelde gösteriliyor, bildirim üretiyordu — sadece
// hiçbir YÖNLENDİRME kararına girmiyordu.
//
// Tasarımın iki emniyet kuralı var, ikisi de aynı ilkeden: bu önbellek bir
// sağlayıcıyı KAPATABİLİR, o yüzden bilgisizliği "kapalı" saymamalı.
//   1. Hiç yüklenmediyse 'unknown' der (açılışta kimseyi elemez).
//   2. Kayıt bayatlarsa 'unknown'a döner (tazeleyici ölmüşse, ölü bir kayıt
//      sağlayıcıyı sonsuza dek kara listede tutamaz).
import type { HealthStatus } from '@ww/providers';

export interface ProviderHealthRow {
  readonly provider_id: string;
  readonly health_status: string;
}

/** Bu yaştan sonra kayıt "bilinmiyor" sayılır: sağlık taraması 60 sn'de bir
 * koşar, yani 5 dakika sessizlik tarayıcının durduğu anlamına gelir. */
export const HEALTH_CACHE_MAX_AGE_MS = 5 * 60_000;

export interface ProviderHealthCacheOptions {
  readonly now?: () => number;
  readonly maxAgeMs?: number;
  readonly onError?: (reason: unknown) => void;
}

export class ProviderHealthCache {
  readonly #load: () => Promise<readonly ProviderHealthRow[]>;
  readonly #now: () => number;
  readonly #maxAgeMs: number;
  readonly #onError: ((reason: unknown) => void) | undefined;
  #status = new Map<string, string>();
  #loadedAt: number | undefined;
  #inFlight: Promise<void> | undefined;

  constructor(
    load: () => Promise<readonly ProviderHealthRow[]>,
    options: ProviderHealthCacheOptions = {},
  ) {
    this.#load = load;
    this.#now = options.now ?? Date.now;
    this.#maxAgeMs = options.maxAgeMs ?? HEALTH_CACHE_MAX_AGE_MS;
    this.#onError = options.onError;
  }

  /** Senkron ve asla beklemez: yönlendiricinin zincir kararı bunun üstünde. */
  statusOf(providerId: string): HealthStatus | 'unknown' {
    if (this.#loadedAt === undefined || this.#now() - this.#loadedAt > this.#maxAgeMs) {
      // Bayat okuma tazelemeyi TETİKLER ama sonucunu beklemez; bu çağrı
      // bir LLM isteğinin önünde duruyor.
      void this.refresh();
      return 'unknown';
    }
    return (this.#status.get(providerId) ?? 'unknown') as HealthStatus | 'unknown';
  }

  /** Aynı anda birden çok tazeleme başlatılmaz: bayat okuma seli tek sorguya iner. */
  async refresh(): Promise<void> {
    this.#inFlight ??= this.#refreshOnce().finally(() => { this.#inFlight = undefined; });
    return this.#inFlight;
  }

  async #refreshOnce(): Promise<void> {
    try {
      const rows = await this.#load();
      this.#status = new Map(rows.map((row) => [row.provider_id, row.health_status]));
      this.#loadedAt = this.#now();
    } catch (reason) {
      // Tazeleme hatası ÖNCEKİ kaydı düşürmez: ClickHouse'un anlık kesintisi
      // yüzünden sağlıklı bir zinciri unutmak, sorunu büyütmek olurdu.
      this.#onError?.(reason);
    }
  }
}
