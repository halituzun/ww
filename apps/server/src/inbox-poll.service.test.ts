import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxPollingModule } from './inbox-poll.module.js';
import {
  InboxPollConfigurationError,
  InboxPollService,
  type InboxDrainPort,
  type InboxPollLogger,
  type InboxPollOptions,
  type InboxWakeupPort,
} from './inbox-poll.service.js';

const silentLogger: InboxPollLogger = Object.freeze({ warn: () => undefined });

function options(overrides: InboxPollOptions = {}): InboxPollOptions {
  return {
    consumerId: 'server-test-consumer',
    pollIntervalMs: 100,
    drainTimeoutMs: 50,
    errorBackoffBaseMs: 20,
    errorBackoffMaxMs: 80,
    errorJitterRatio: 0,
    shutdownTimeoutMs: 25,
    logger: silentLogger,
    ...overrides,
  };
}

function service(
  drainPort: InboxDrainPort,
  overrides: InboxPollOptions = {},
  wakeupPort: InboxWakeupPort | null = null,
): InboxPollService {
  return new InboxPollService(drainPort, wakeupPort, options(overrides));
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('InboxPollService', () => {
  it('başlatmayı idempotent tutar ve stop sonrasında yeni drain başlatmaz', async () => {
    vi.useFakeTimers();
    const drainOnce = vi.fn<InboxDrainPort['drainOnce']>().mockResolvedValue(undefined);
    const runtime = service({ drainOnce });

    runtime.start();
    runtime.start();
    await flushMicrotasks();
    expect(drainOnce).toHaveBeenCalledTimes(1);
    expect(drainOnce).toHaveBeenCalledWith(
      'server-test-consumer',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    await runtime.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(drainOnce).toHaveBeenCalledTimes(1);
  });

  it('önceden abort edilmiş parent signal ile hiç başlamaz', async () => {
    const drainOnce = vi.fn<InboxDrainPort['drainOnce']>().mockResolvedValue(undefined);
    const runtime = service({ drainOnce });
    const parent = new AbortController();
    parent.abort();

    runtime.start(parent.signal);
    await flushMicrotasks();

    expect(drainOnce).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it('asılı drain için deadline sinyalini abort eder ve çağrıları çakıştırmaz', async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    let aborts = 0;
    const drainOnce = vi.fn<InboxDrainPort['drainOnce']>()
      .mockImplementation(async (_consumerId, context) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await new Promise<void>((_resolve, reject) => {
            context.signal.addEventListener('abort', () => {
              aborts += 1;
              reject(new DOMException('aborted', 'AbortError'));
            }, { once: true });
          });
        } finally {
          active -= 1;
        }
      });
    const runtime = service({ drainOnce });

    runtime.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(50);
    expect(aborts).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(drainOnce).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);

    const stopped = runtime.stop();
    await flushMicrotasks();
    await stopped;
  });

  it('abort sinyalini yok sayan asılı port varken yeni iteration başlatmaz', async () => {
    vi.useFakeTimers();
    const drainOnce = vi.fn<InboxDrainPort['drainOnce']>()
      .mockImplementation(() => new Promise<never>(() => undefined));
    const runtime = service({ drainOnce, }, { shutdownTimeoutMs: 5 });

    runtime.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(500);

    expect(drainOnce).toHaveBeenCalledTimes(1);
    const stopped = runtime.stop();
    await vi.advanceTimersByTimeAsync(10);
    await stopped;
  });

  it('geçici hatadan sonra üstel backoff ile durable poll işlemeye devam eder', async () => {
    vi.useFakeTimers();
    const drainOnce = vi.fn<InboxDrainPort['drainOnce']>()
      .mockRejectedValueOnce(new Error('clickhouse geçici kapalı'))
      .mockResolvedValue(undefined);
    const runtime = service({ drainOnce });

    runtime.start();
    await flushMicrotasks();
    expect(drainOnce).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(19);
    expect(drainOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(drainOnce).toHaveBeenCalledTimes(2);

    await runtime.stop();
  });

  it('exception message içindeki sırları loglamaz ve yalnız allowlisted kod yazar', async () => {
    vi.useFakeTimers();
    const warn = vi.fn<InboxPollLogger['warn']>();
    const secret = 'sk-live-cok-gizli-api-anahtari';
    const drainOnce = vi.fn<InboxDrainPort['drainOnce']>()
      .mockRejectedValueOnce(new Error(`provider reddetti: ${secret}`))
      .mockResolvedValue(undefined);
    const wakeupPort: InboxWakeupPort = {
      wait: async () => {
        throw new Error(`redis credential: ${secret}`);
      },
    };
    const runtime = service({ drainOnce }, { logger: { warn } }, wakeupPort);

    runtime.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(20);
    await flushMicrotasks();

    const logged = warn.mock.calls.flat().join('\n');
    expect(logged).toContain('code=DRAIN_FAILED');
    expect(logged).toContain('code=WAKEUP_UNAVAILABLE');
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain('provider reddetti');
    expect(logged).not.toContain('redis credential');

    await runtime.stop();
  });

  it('deadline sonrasında geç reddeden drain promiseini gözlemler', async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    let rejectDrain: ((error: Error) => void) | undefined;
    const drainOnce = vi.fn<InboxDrainPort['drainOnce']>()
      .mockImplementation(() => new Promise<never>((_resolve, reject) => {
        rejectDrain = reject;
      }));
    const runtime = service({ drainOnce }, { shutdownTimeoutMs: 5 });

    try {
      runtime.start();
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(50);
      rejectDrain?.(new Error('geç gelen hassas hata'));
      await flushMicrotasks();

      expect(unhandled).toEqual([]);
      const stopped = runtime.stop();
      await vi.advanceTimersByTimeAsync(5);
      await stopped;
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('hata backoffunu üstel artırır ve üst sınırda tutar', async () => {
    vi.useFakeTimers();
    const drainOnce = vi.fn<InboxDrainPort['drainOnce']>()
      .mockRejectedValue(new Error('geçici hata'));
    const runtime = service({ drainOnce });

    runtime.start();
    await flushMicrotasks();
    expect(drainOnce).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20);
    expect(drainOnce).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(40);
    expect(drainOnce).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(80);
    expect(drainOnce).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(80);
    expect(drainOnce).toHaveBeenCalledTimes(5);

    await runtime.stop();
  });

  it('Redis wakeup olmadan periyodik durable taramada sonradan gelen işi bulur', async () => {
    vi.useFakeTimers();
    const scans: number[] = [];
    const drainOnce = vi.fn<InboxDrainPort['drainOnce']>()
      .mockImplementation(async () => {
        scans.push(scans.length === 0 ? 0 : 1);
      });
    const runtime = service({ drainOnce });

    runtime.start();
    await flushMicrotasks();
    expect(scans).toEqual([0]);
    await vi.advanceTimersByTimeAsync(100);
    expect(scans).toEqual([0, 1]);

    await runtime.stop();
  });

  it('opsiyonel wakeup periyodik taramayı yalnızca hızlandırır', async () => {
    vi.useFakeTimers();
    let wake: (() => void) | undefined;
    const wakeupPort: InboxWakeupPort = {
      wait: (signal) => new Promise<void>((resolve, reject) => {
        const onAbort = (): void => reject(new DOMException('aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
        wake = () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
      }),
    };
    const drainOnce = vi.fn<InboxDrainPort['drainOnce']>().mockResolvedValue(undefined);
    const runtime = service({ drainOnce }, { pollIntervalMs: 1_000 }, wakeupPort);

    runtime.start();
    await flushMicrotasks();
    expect(drainOnce).toHaveBeenCalledTimes(1);
    expect(wake).toBeTypeOf('function');
    wake?.();
    await flushMicrotasks();
    expect(drainOnce).toHaveBeenCalledTimes(2);

    const stopped = runtime.stop();
    await vi.advanceTimersByTimeAsync(25);
    await stopped;
  });

  it('wakeup hatasında timer tabanlı kalıcı polla geri döner', async () => {
    vi.useFakeTimers();
    const wakeupPort: InboxWakeupPort = {
      wait: async () => {
        throw new Error('Redis yok');
      },
    };
    const drainOnce = vi.fn<InboxDrainPort['drainOnce']>().mockResolvedValue(undefined);
    const runtime = service({ drainOnce }, {}, wakeupPort);

    runtime.start();
    await flushMicrotasks();
    expect(drainOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(drainOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(drainOnce).toHaveBeenCalledTimes(2);

    await runtime.stop();
  });

  it('shutdown aktif draini abort eder ve wakeup kaynağını bir kez kapatır', async () => {
    const close = vi.fn<NonNullable<InboxWakeupPort['close']>>().mockResolvedValue(undefined);
    const wakeupPort: InboxWakeupPort = {
      wait: async (signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        });
      },
      close,
    };
    let drainSignal: AbortSignal | undefined;
    const drainOnce: InboxDrainPort['drainOnce'] = async (_consumerId, context) => {
      drainSignal = context.signal;
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    };
    const runtime = service({ drainOnce }, {}, wakeupPort);

    runtime.start();
    await flushMicrotasks();
    await runtime.stop();
    await runtime.stop();

    expect(drainSignal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ pollIntervalMs: 0 }, 'pollIntervalMs'],
    [{ drainTimeoutMs: Number.NaN }, 'drainTimeoutMs'],
    [{ errorBackoffBaseMs: 20, errorBackoffMaxMs: 10 }, 'errorBackoffMaxMs'],
    [{ errorJitterRatio: 1.1 }, 'errorJitterRatio'],
    [{ consumerId: ' ' }, 'consumerId'],
  ] satisfies ReadonlyArray<readonly [InboxPollOptions, string]>) (
    'geçersiz yapılandırmayı başlangıçta reddeder: %s',
    (invalid, expected) => {
      expect(() => service({ drainOnce: async () => undefined }, invalid))
        .toThrowError(InboxPollConfigurationError);
      expect(() => service({ drainOnce: async () => undefined }, invalid))
        .toThrowError(expected);
    },
  );

  it('Nest lifecycle ile başlar ve uygulama kapanışında durur', async () => {
    const drainOnce = vi.fn<InboxDrainPort['drainOnce']>().mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      imports: [InboxPollingModule.forRoot({
        drainPort: { drainOnce },
        poll: options(),
      })],
    }).compile();
    const app = moduleRef.createNestApplication();

    await app.init();
    await flushMicrotasks();
    expect(drainOnce).toHaveBeenCalledTimes(1);

    await app.close();
  });
});
