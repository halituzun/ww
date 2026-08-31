import {
  getFencedLease,
  releaseFencedLease,
  renewFencedLease,
  type FencedLease,
  type WwRedis,
} from '@ww/db';
import { SchedulerError } from './errors.js';

/** Keeps one fenced lease alive and makes every durable write assert ownership. */
export class FencedLeaseGuard {
  readonly lease: FencedLease;
  readonly #redis: WwRedis;
  readonly #ttlMs: number;
  readonly #timer: ReturnType<typeof setInterval>;
  #tail: Promise<void> = Promise.resolve();
  #lost = false;
  #stopped = false;
  #failure: unknown;

  constructor(redis: WwRedis, lease: FencedLease, ttlMs: number) {
    this.#redis = redis;
    this.lease = lease;
    this.#ttlMs = ttlMs;
    const intervalMs = Math.max(1, Math.floor(ttlMs / 3));
    this.#timer = setInterval(() => {
      void this.#renew().catch(() => undefined);
    }, intervalMs);
    this.#timer.unref();
  }

  async assertHeld(): Promise<void> {
    if (this.#stopped || this.#lost) this.#throwLost();
    await this.#renew();
    if (this.#stopped || this.#lost) this.#throwLost();
  }

  async after<T>(operation: Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await operation;
    } catch (error) {
      // A failed/ambiguous durable call may have outlived this owner. Prefer the
      // stale-fence signal so the caller enters fresh reconciliation.
      await this.assertHeld();
      throw error;
    }
    await this.assertHeld();
    return result;
  }

  async stop(release: boolean): Promise<boolean> {
    if (this.#stopped) return false;
    this.#stopped = true;
    clearInterval(this.#timer);
    await this.#tail;
    if (!release) return !this.#lost;
    let releaseFailure: unknown;
    try {
      if (await releaseFencedLease(this.#redis, this.lease)) return true;
      releaseFailure = new Error('fenced lease compare-and-delete false dondurdu');
    } catch (error) {
      releaseFailure = error;
    }
    let observed: FencedLease | null;
    try {
      observed = await getFencedLease(this.#redis, this.lease.lockKey);
    } catch (reconciliation) {
      throw new SchedulerError(
        'UNCERTAIN_WRITE',
        `fenced lease release sonucu okunamadi: ${this.lease.lockKey}:${this.lease.fence}`,
        { release: releaseFailure, reconciliation },
      );
    }
    if (observed === null) return true;
    if (observed.owner === this.lease.owner && observed.fence === this.lease.fence) {
      throw new SchedulerError(
        'UNCERTAIN_WRITE',
        `fenced lease release sonrasi eski owner kaldi: ${this.lease.lockKey}:${this.lease.fence}`,
        releaseFailure,
      );
    }
    return false;
  }

  async #renew(): Promise<void> {
    const previous = this.#tail;
    let resolveTail: (() => void) | undefined;
    this.#tail = new Promise<void>((resolve) => { resolveTail = resolve; });
    await previous;
    try {
      if (this.#stopped || this.#lost) return;
      const held = await renewFencedLease(this.#redis, this.lease, this.#ttlMs);
      if (!held) this.#lost = true;
    } catch (error) {
      this.#failure = error;
      this.#lost = true;
      this.#throwLost();
    } finally {
      resolveTail?.();
    }
  }

  #throwLost(): never {
    throw new SchedulerError(
      'STALE_FENCE',
      `fenced lease sahipligi kaybedildi: ${this.lease.lockKey}:${this.lease.fence}`,
      this.#failure,
    );
  }
}
