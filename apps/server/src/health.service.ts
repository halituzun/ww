import { Inject, Injectable } from '@nestjs/common';
import { createCh, createRedis } from '@ww/db';
import type { HealthReport } from '@ww/shared';

export const HEALTH_PROBE_TIMEOUT_MS = 750;
export const HEALTH_CLEANUP_TIMEOUT_MS = 250;

interface HealthClickhouseClient {
  ping(options: { select: true; abort_signal: AbortSignal }): Promise<{ success: boolean }>;
  close(): Promise<void>;
}

interface HealthRedisClient {
  ping(): Promise<unknown>;
  destroy(): void;
}

export interface HealthDependencies {
  createClickhouse(): HealthClickhouseClient;
  createRedis(): Promise<HealthRedisClient>;
}

export const HEALTH_DEPENDENCIES = Symbol('HEALTH_DEPENDENCIES');

export const DEFAULT_HEALTH_DEPENDENCIES: HealthDependencies = {
  // ClickHouse'un belgelenmiş request timeout'u sürücü seviyesinde de probe'u sınırlar.
  createClickhouse: () => createCh({ requestTimeoutMs: HEALTH_PROBE_TIMEOUT_MS }),
  createRedis: () => createRedis(undefined, {
    connectTimeoutMs: HEALTH_PROBE_TIMEOUT_MS,
    maxReconnectAttempts: 0,
    // HealthService bağlantı hatasını degraded durumuna dönüştürür.
    onError: () => undefined,
  }),
};

async function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // Zaman aşımı sonucu, iptal kancasının davranışından bağımsız olmalıdır.
      }
      reject(new Error(`sağlık probe zaman aşımı (${timeoutMs} ms)`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function cleanupWithin(work: Promise<unknown>): Promise<boolean> {
  try {
    await withDeadline(work, HEALTH_CLEANUP_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(HEALTH_DEPENDENCIES) private readonly dependencies: HealthDependencies,
  ) {}

  async check(): Promise<HealthReport> {
    const [clickhouse, redis] = await Promise.all([this.checkClickhouse(), this.checkRedis()]);
    return { ok: clickhouse && redis, clickhouse, redis };
  }

  private async checkClickhouse(): Promise<boolean> {
    let client: HealthClickhouseClient | undefined;
    let healthy = false;
    const controller = new AbortController();

    try {
      client = this.dependencies.createClickhouse();
      const result = await withDeadline(
        client.ping({ select: true, abort_signal: controller.signal }),
        HEALTH_PROBE_TIMEOUT_MS,
        () => controller.abort(),
      );
      healthy = result.success;
    } catch {
      healthy = false;
    } finally {
      if (client && !(await cleanupWithin(client.close()))) healthy = false;
    }

    return healthy;
  }

  private async checkRedis(): Promise<boolean> {
    let client: HealthRedisClient | undefined;
    let healthy = false;

    try {
      client = await withDeadline(
        this.dependencies.createRedis(),
        HEALTH_PROBE_TIMEOUT_MS,
      );
      await withDeadline(client.ping(), HEALTH_PROBE_TIMEOUT_MS);
      healthy = true;
    } catch {
      healthy = false;
    } finally {
      if (client) {
        try {
          // Health istemcisi tek probe içindir; QUIT yanıtını beklemeden soketi kapat.
          client.destroy();
        } catch {
          healthy = false;
        }
      }
    }

    return healthy;
  }
}
