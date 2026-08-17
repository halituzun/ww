// Süpürücünün üretim sürücüsü: periyodik kurtarma turu.
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { RecoveryService } from '@ww/memory';
import { createRedis, type WwRedis } from '@ww/db';
import { EntityIdSchema } from '@ww/shared';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';
import { RECOVERY_SWEEP_INTERVAL_MS, sweepRecovery } from './recovery-sweeper.js';

@Injectable()
export class RecoverySweeperService implements OnModuleInit, OnModuleDestroy {
  readonly #logger = new Logger(RecoverySweeperService.name);
  readonly #database: ServerDatabase;
  #timer: ReturnType<typeof setInterval> | undefined;
  #redis: Promise<WwRedis> | undefined;
  #running = false;

  constructor(@Inject(SERVER_DATABASE) database: ServerDatabase) {
    this.#database = database;
  }

  onModuleInit(): void {
    if (process.env['WW_DISABLE_RECOVERY_SWEEP'] === '1') {
      this.#logger.log('kurtarma süpürücüsü WW_DISABLE_RECOVERY_SWEEP=1 ile kapatıldı');
      return;
    }
    const projectId = process.env['WW_RUNTIME_PROJECT_ID'];
    if (projectId === undefined || projectId.trim() === '') return;
    this.#timer = setInterval(() => { void this.sweep(projectId); }, RECOVERY_SWEEP_INTERVAL_MS);
    this.#timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Üst üste binmeyi engeller: iki kurtarma aynı görevi iki kez düşürmemeli. */
  async sweep(projectIdValue: string): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      this.#redis ??= this.#database.redis === undefined
        ? createRedis()
        : Promise.resolve(this.#database.redis);
      const redis = await this.#redis;
      const service = new RecoveryService(this.#database.ch, redis);
      await sweepRecovery({
        recover: () => service.recoverProject(EntityIdSchema.parse(projectIdValue)) as never,
        log: (message) => this.#logger.log(message),
        onError: (reason) => this.#logger.warn(`kurtarma süpürücüsü başarısız: ${String(reason)}`),
      });
    } finally {
      this.#running = false;
    }
  }
}
