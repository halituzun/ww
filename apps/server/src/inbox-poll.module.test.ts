import type { InboxWorker } from '@ww/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inboxWorkerDrainPort } from './inbox-poll.module.js';
import { InboxPollService } from './inbox-poll.service.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('inboxWorkerDrainPort', () => {
  it('documented InboxWorker imzasını çağırır', async () => {
    const drainOnce = vi.fn<InboxWorker['drainOnce']>().mockResolvedValue({
      consumerId: 'consumer-1',
      scanned: 0,
      processed: 0,
      retryScheduled: 0,
      failed: 0,
      busy: 0,
      stale: 0,
      errors: 0,
      quarantined: 0,
      results: [],
    });
    const port = inboxWorkerDrainPort({ drainOnce });
    const controller = new AbortController();

    await port.drainOnce('consumer-1', { signal: controller.signal });

    expect(drainOnce).toHaveBeenCalledOnce();
    expect(drainOnce).toHaveBeenCalledWith(
      'consumer-1',
      controller.signal,
    );
  });

  it('önceden abort edilmiş iterationı workera iletmez', async () => {
    const drainOnce = vi.fn<InboxWorker['drainOnce']>();
    const port = inboxWorkerDrainPort({ drainOnce });
    const controller = new AbortController();
    controller.abort();

    await expect(port.drainOnce('consumer-1', { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(drainOnce).not.toHaveBeenCalled();
  });

  it('hiç bitmeyen worker çağrısını abort eder, gözlemler ve üst üste bindirmez', async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;
    const drainOnce = vi.fn<InboxWorker['drainOnce']>()
      .mockImplementation((_consumerId, signal) => {
        receivedSignal = signal;
        return new Promise<never>(() => undefined);
      });
    const runtime = new InboxPollService(inboxWorkerDrainPort({ drainOnce }), null, {
      consumerId: 'consumer-1',
      pollIntervalMs: 10,
      drainTimeoutMs: 5,
      errorBackoffBaseMs: 5,
      errorBackoffMaxMs: 5,
      errorJitterRatio: 0,
      shutdownTimeoutMs: 5,
      logger: { warn: () => undefined },
    });

    runtime.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5);
    expect(receivedSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(drainOnce).toHaveBeenCalledTimes(1);

    const stopped = runtime.stop();
    await vi.advanceTimersByTimeAsync(5);
    await stopped;
  });
});
