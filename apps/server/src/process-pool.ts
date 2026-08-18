// Dev-server yaşam döngüsünün saf parçaları (docs/05 → Dev-Server Yaşam Döngüsü).
//
// NEDEN VAR: docs/05 `ProcessManager`'ı port havuzu ve halka tamponuyla
// tanımlıyor, docs/11 Faz 6 da önizlemeyi buna dayandırıyor. Hiçbiri
// yazılmamıştı: panelin önizleme sekmesi sabit bir env değişkenine bakıyor,
// yoksa `about:blank` gösteriyordu — yani "canlı önizleme" diye bir şey yoktu.

export class PortPoolError extends Error {}

/** docs/05: port havuzu 42000-42999. */
export const PORT_POOL_START = 42_000;
export const PORT_POOL_END = 42_999;

/**
 * Port atama. Aynı anahtara ikinci kez sorulunca AYNI port döner: yeniden
 * başlatmada portun değişmesi, paneldeki iframe'i sessizce kırardı.
 */
export class PortPool {
  readonly #assigned = new Map<string, number>();

  /**
   * `preferred`: daha önce KAYITLI olan port. Süreç yeniden başlayınca aynı
   * projeye aynı portu vermek için; başkası tutuyorsa yok sayılır.
   */
  assign(key: string, preferred?: number): number {
    const existing = this.#assigned.get(key);
    if (existing !== undefined) return existing;
    const used = new Set(this.#assigned.values());
    if (
      preferred !== undefined && !used.has(preferred)
      && preferred >= PORT_POOL_START && preferred <= PORT_POOL_END
    ) {
      this.#assigned.set(key, preferred);
      return preferred;
    }
    for (let port = PORT_POOL_START; port <= PORT_POOL_END; port += 1) {
      if (used.has(port)) continue;
      this.#assigned.set(key, port);
      return port;
    }
    throw new PortPoolError('port havuzu tukendi: 42000-42999');
  }

  release(key: string): void {
    this.#assigned.delete(key);
  }

  portOf(key: string): number | undefined {
    return this.#assigned.get(key);
  }
}

/** docs/05: "panelden son 200 satır log". */
export const OUTPUT_RING_LIMIT = 200;

/**
 * Süreç çıktısının halka tamponu. Sınırsız biriktirmek belleği şişirir; en
 * ESKİ satırlar düşer çünkü çöken bir süreçte son satırlar tanısal olandır.
 */
export class OutputRing {
  readonly #lines: string[] = [];
  readonly #limit: number;

  constructor(limit: number = OUTPUT_RING_LIMIT) {
    this.#limit = Number.isSafeInteger(limit) && limit > 0 ? limit : OUTPUT_RING_LIMIT;
  }

  push(chunk: string): void {
    for (const line of chunk.split('\n')) {
      if (line.trim() === '') continue;
      this.#lines.push(line);
    }
    while (this.#lines.length > this.#limit) this.#lines.shift();
  }

  lines(): readonly string[] {
    return Object.freeze([...this.#lines]);
  }
}
