// Sağlayıcı başına istek/dakika sınırı (docs/04 → rate limit; docs/07 →
// "provider router token-bucket").
//
// NEDEN VAR: iki doküman da bu bileşeni ADIYLA tanımlıyordu ama hiç
// yazılmamıştı. Risk teorik değil: pompa artık görevleri eşzamanlı işliyor
// ve fallback zinciri yeniden deniyor; sınırsız çıkış 429'a çarpar ve
// 429'lar fallback'i tetikleyip yükü daha da artırır.
//
// Bekletmek reddetmekten iyidir: istek DÜŞÜRÜLMEZ, sırası gelene kadar
// beklenir (docs/07: "router bekletir").

export interface TokenBucketOptions {
  /** Dakikada izin verilen istek. 0 ya da tanımsız = sınırsız. */
  readonly perMinute: number;
  readonly now?: () => number;
}

export class TokenBucket {
  readonly #capacity: number;
  readonly #refillPerMs: number;
  readonly #now: () => number;
  #tokens: number;
  #lastRefillAt: number;

  constructor(options: TokenBucketOptions) {
    const perMinute = Number.isFinite(options.perMinute) && options.perMinute > 0
      ? Math.floor(options.perMinute)
      : 0;
    this.#capacity = perMinute;
    this.#refillPerMs = perMinute / 60_000;
    this.#now = options.now ?? (() => Date.now());
    this.#tokens = perMinute;
    this.#lastRefillAt = this.#now();
  }

  get unlimited(): boolean {
    return this.#capacity === 0;
  }

  #refill(): void {
    const now = this.#now();
    const elapsed = now - this.#lastRefillAt;
    // Saat geriye giderse jeton ÜRETİLMEZ; sınırı gevşetmek yerine bekletiriz.
    if (elapsed <= 0) return;
    this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#refillPerMs);
    this.#lastRefillAt = now;
  }

  /**
   * Bir jeton ayırır. Jeton varsa 0, yoksa BEKLENMESİ GEREKEN milisaniyeyi
   * döner. Çağıran beklemeyi kendi yapar; böylece bekleme test edilebilir
   * kalır ve gerçek zamanlayıcıya bağlanmaz.
   */
  reserve(): number {
    if (this.unlimited) return 0;
    this.#refill();
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return 0;
    }
    const missing = 1 - this.#tokens;
    // Jeton borçlanılır: bekleyen istek sıraya girmiş sayılır, yoksa aynı anda
    // gelen çok sayıda istek aynı bekleme süresini paylaşıp birlikte patlar.
    this.#tokens -= 1;
    return Math.ceil(missing / this.#refillPerMs);
  }
}

/** Sağlayıcı başına kova havuzu. */
export class ProviderRateLimiter {
  readonly #buckets = new Map<string, TokenBucket>();
  readonly #limitFor: (providerId: string) => number;
  readonly #now: () => number;

  constructor(
    limitFor: (providerId: string) => number,
    now: () => number = () => Date.now(),
  ) {
    this.#limitFor = limitFor;
    this.#now = now;
  }

  reserve(providerId: string): number {
    let bucket = this.#buckets.get(providerId);
    if (bucket === undefined) {
      bucket = new TokenBucket({ perMinute: this.#limitFor(providerId), now: this.#now });
      this.#buckets.set(providerId, bucket);
    }
    return bucket.reserve();
  }
}
