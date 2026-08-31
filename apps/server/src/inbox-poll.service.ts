import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const DEFAULT_ERROR_BACKOFF_BASE_MS = 500;
const DEFAULT_ERROR_BACKOFF_MAX_MS = 30_000;
const DEFAULT_ERROR_JITTER_RATIO = 0.2;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_DURATION_MS = 3_600_000;

export interface InboxDrainContext {
  readonly signal: AbortSignal;
}

export interface InboxDrainPort {
  drainOnce(consumerId: string, context: InboxDrainContext): Promise<unknown>;
}

export interface InboxWakeupPort {
  wait(signal: AbortSignal): Promise<void>;
  close?(): Promise<void> | void;
}

export interface InboxPollLogger {
  warn(message: string): void;
}

export interface InboxPollOptions {
  readonly consumerId?: string;
  readonly pollIntervalMs?: number;
  readonly drainTimeoutMs?: number;
  readonly errorBackoffBaseMs?: number;
  readonly errorBackoffMaxMs?: number;
  readonly errorJitterRatio?: number;
  readonly shutdownTimeoutMs?: number;
  readonly random?: () => number;
  readonly logger?: InboxPollLogger;
}

interface ValidatedInboxPollOptions {
  readonly consumerId: string;
  readonly pollIntervalMs: number;
  readonly drainTimeoutMs: number;
  readonly errorBackoffBaseMs: number;
  readonly errorBackoffMaxMs: number;
  readonly errorJitterRatio: number;
  readonly shutdownTimeoutMs: number;
  readonly random: () => number;
  readonly logger: InboxPollLogger;
}

export const INBOX_DRAIN_PORT = Symbol('INBOX_DRAIN_PORT');
export const INBOX_WAKEUP_PORT = Symbol('INBOX_WAKEUP_PORT');
export const INBOX_POLL_OPTIONS = Symbol('INBOX_POLL_OPTIONS');

export class InboxPollConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboxPollConfigurationError';
  }
}

export class InboxDrainTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`inbox drain ${timeoutMs} ms icinde tamamlanmadi`);
    this.name = 'InboxDrainTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

class InboxPollAbortError extends Error {
  constructor() {
    super('inbox poll durduruldu');
    this.name = 'InboxPollAbortError';
  }
}

function duration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_DURATION_MS) {
    throw new InboxPollConfigurationError(
      `${name} 1-${MAX_DURATION_MS} araliginda tam sayi olmalidir`,
    );
  }
  return value;
}

function validateOptions(options: InboxPollOptions): ValidatedInboxPollOptions {
  const consumerId = options.consumerId ?? `ww-server-inbox-${process.pid}`;
  if (consumerId.trim().length === 0 || consumerId.length > 200) {
    throw new InboxPollConfigurationError('consumerId 1-200 karakter araliginda olmalidir');
  }

  const errorBackoffBaseMs = duration(
    options.errorBackoffBaseMs ?? DEFAULT_ERROR_BACKOFF_BASE_MS,
    'errorBackoffBaseMs',
  );
  const errorBackoffMaxMs = duration(
    options.errorBackoffMaxMs ?? DEFAULT_ERROR_BACKOFF_MAX_MS,
    'errorBackoffMaxMs',
  );
  if (errorBackoffMaxMs < errorBackoffBaseMs) {
    throw new InboxPollConfigurationError(
      'errorBackoffMaxMs errorBackoffBaseMs degerinden kucuk olamaz',
    );
  }

  const errorJitterRatio = options.errorJitterRatio ?? DEFAULT_ERROR_JITTER_RATIO;
  if (!Number.isFinite(errorJitterRatio) || errorJitterRatio < 0 || errorJitterRatio > 1) {
    throw new InboxPollConfigurationError('errorJitterRatio 0-1 araliginda olmalidir');
  }
  if (options.random !== undefined && typeof options.random !== 'function') {
    throw new InboxPollConfigurationError('random bir fonksiyon olmalidir');
  }

  return Object.freeze({
    consumerId,
    pollIntervalMs: duration(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      'pollIntervalMs',
    ),
    drainTimeoutMs: duration(
      options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
      'drainTimeoutMs',
    ),
    errorBackoffBaseMs,
    errorBackoffMaxMs,
    errorJitterRatio,
    shutdownTimeoutMs: duration(
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      'shutdownTimeoutMs',
    ),
    random: options.random ?? Math.random,
    logger: options.logger ?? new Logger(InboxPollService.name),
  });
}

function abortError(): InboxPollAbortError {
  return new InboxPollAbortError();
}

function isPollAbortError(error: unknown): boolean {
  return error instanceof InboxPollAbortError;
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    timer.unref?.();

    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function observed<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => undefined);
  return promise;
}

function drainFailureCode(error: unknown): 'DRAIN_TIMEOUT' | 'DRAIN_FAILED' {
  return error instanceof InboxDrainTimeoutError ? 'DRAIN_TIMEOUT' : 'DRAIN_FAILED';
}

@Injectable()
export class InboxPollService implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly #drainPort: InboxDrainPort;
  readonly #wakeupPort: InboxWakeupPort | null;
  readonly #options: ValidatedInboxPollOptions;
  #lifecycle: AbortController | undefined;
  #loop: Promise<void> | undefined;
  #inFlight: Promise<unknown> | undefined;
  #removeParentAbortListener: (() => void) | undefined;
  #stopPromise: Promise<void> | undefined;
  #stopped = false;

  constructor(
    @Inject(INBOX_DRAIN_PORT) drainPort: InboxDrainPort,
    @Inject(INBOX_WAKEUP_PORT) wakeupPort: InboxWakeupPort | null,
    @Inject(INBOX_POLL_OPTIONS) options: InboxPollOptions,
  ) {
    this.#drainPort = drainPort;
    this.#wakeupPort = wakeupPort;
    this.#options = validateOptions(options);
  }

  onApplicationBootstrap(): void {
    this.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(parentSignal?: AbortSignal): void {
    if (this.#stopped || this.#loop !== undefined) return;
    if (parentSignal?.aborted === true) {
      this.#stopped = true;
      return;
    }

    const lifecycle = new AbortController();
    this.#lifecycle = lifecycle;
    if (parentSignal !== undefined) {
      const onParentAbort = (): void => lifecycle.abort(parentSignal.reason);
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
      this.#removeParentAbortListener = () => {
        parentSignal.removeEventListener('abort', onParentAbort);
      };
    }

    const loop = this.#run(lifecycle.signal).catch((error: unknown) => {
      if (!lifecycle.signal.aborted) {
        void error;
        this.#options.logger.warn('inbox poll beklenmeyen nedenle durdu; code=POLL_LOOP_STOPPED');
      }
    });
    const tracked = observed(loop.finally(() => {
      this.#removeParentAbortListener?.();
      this.#removeParentAbortListener = undefined;
      if (this.#loop === tracked) this.#loop = undefined;
    }));
    this.#loop = tracked;
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stop();
    return this.#stopPromise;
  }

  async #stop(): Promise<void> {
    this.#stopped = true;
    this.#lifecycle?.abort(abortError());

    const cleanup: Promise<unknown>[] = [];
    if (this.#loop !== undefined) cleanup.push(this.#loop);
    if (this.#inFlight !== undefined) cleanup.push(this.#inFlight);
    if (this.#wakeupPort?.close !== undefined) {
      try {
        cleanup.push(Promise.resolve(this.#wakeupPort.close()));
      } catch (error) {
        cleanup.push(Promise.reject(error));
      }
    }
    if (cleanup.length > 0) {
      await this.#settleWithin(
        Promise.allSettled(cleanup),
        this.#options.shutdownTimeoutMs,
        'inbox poll kaynaklari',
      );
    }
  }

  async #run(signal: AbortSignal): Promise<void> {
    let consecutiveErrors = 0;
    while (!signal.aborted) {
      if (this.#inFlight !== undefined) {
        try {
          await this.#waitForTrigger(this.#options.pollIntervalMs, signal);
        } catch (error) {
          if (signal.aborted || isPollAbortError(error)) return;
          this.#options.logger.warn('inbox poll bekleme hatasi; code=POLL_WAIT_FAILED');
        }
        continue;
      }

      try {
        await this.#drainWithDeadline(signal);
        consecutiveErrors = 0;
        await this.#waitForTrigger(this.#options.pollIntervalMs, signal);
      } catch (error) {
        if (signal.aborted || isPollAbortError(error)) return;
        consecutiveErrors += 1;
        const backoffMs = this.#backoffMs(consecutiveErrors);
        this.#options.logger.warn(
          `inbox drain basarisiz; code=${drainFailureCode(error)}; ` +
          `${backoffMs} ms sonra tekrar denenecek`,
        );
        try {
          await this.#waitForTrigger(backoffMs, signal);
        } catch (waitError) {
          if (signal.aborted || isPollAbortError(waitError)) return;
          this.#options.logger.warn('inbox poll bekleme hatasi; code=POLL_WAIT_FAILED');
        }
      }
    }
  }

  async #drainWithDeadline(parentSignal: AbortSignal): Promise<void> {
    if (parentSignal.aborted) throw abortError();
    const controller = new AbortController();
    const timeoutError = new InboxDrainTimeoutError(this.#options.drainTimeoutMs);
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const onParentAbort = (): void => controller.abort(parentSignal.reason);
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
    const removeParentAbortListener = (): void => {
      parentSignal.removeEventListener('abort', onParentAbort);
    };

    const drain = Promise.resolve().then(() => this.#drainPort.drainOnce(
      this.#options.consumerId,
      Object.freeze({ signal: controller.signal }),
    ));
    const tracked = observed(drain.finally(() => {
      if (this.#inFlight === tracked) this.#inFlight = undefined;
    }));
    this.#inFlight = tracked;

    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(timeoutError);
        controller.abort(timeoutError);
      }, this.#options.drainTimeoutMs);
      timeout.unref?.();
    });
    let removeAbortRaceListener: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      if (parentSignal.aborted) {
        reject(abortError());
        return;
      }
      const onAbortRace = (): void => reject(abortError());
      parentSignal.addEventListener('abort', onAbortRace, { once: true });
      removeAbortRaceListener = () => {
        parentSignal.removeEventListener('abort', onAbortRace);
      };
    });

    try {
      await Promise.race([tracked, deadline, aborted]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      removeParentAbortListener();
      removeAbortRaceListener?.();
      controller.abort();
    }
  }

  async #waitForTrigger(delayMs: number, parentSignal: AbortSignal): Promise<void> {
    if (this.#wakeupPort === null) {
      await abortableDelay(delayMs, parentSignal);
      return;
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const onParentAbort = (): void => controller.abort(parentSignal.reason);
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
    try {
      await Promise.race([
        abortableDelay(delayMs, controller.signal),
        this.#wakeupPort.wait(controller.signal),
      ]);
    } catch (error) {
      if (parentSignal.aborted || isPollAbortError(error)) throw abortError();
      controller.abort();
      this.#options.logger.warn(
        'inbox wakeup kullanilamadi; code=WAKEUP_UNAVAILABLE; kalici poll devam ediyor',
      );
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      const remainingMs = Math.max(1, delayMs - elapsedMs);
      await abortableDelay(remainingMs, parentSignal);
    } finally {
      parentSignal.removeEventListener('abort', onParentAbort);
      controller.abort();
    }
  }

  #backoffMs(errorCount: number): number {
    const exponent = Math.min(errorCount - 1, 30);
    const withoutJitter = Math.min(
      this.#options.errorBackoffMaxMs,
      this.#options.errorBackoffBaseMs * (2 ** exponent),
    );
    const random = this.#options.random();
    if (!Number.isFinite(random) || random < 0 || random > 1) {
      throw new InboxPollConfigurationError('random 0-1 araliginda sonuc uretmelidir');
    }
    const spread = withoutJitter * this.#options.errorJitterRatio;
    return Math.max(1, Math.round(withoutJitter - spread + (2 * spread * random)));
  }

  async #settleWithin(
    work: Promise<unknown>,
    timeoutMs: number,
    description: string,
  ): Promise<void> {
    const observedWork = observed(work.then(() => undefined));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => resolve('timeout'), timeoutMs);
      timeout.unref?.();
    });
    try {
      const result = await Promise.race([
        observedWork.then(() => 'settled' as const, () => 'settled' as const),
        deadline,
      ]);
      if (result === 'timeout') {
        this.#options.logger.warn(`${description} ${timeoutMs} ms icinde kapanmadi`);
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
