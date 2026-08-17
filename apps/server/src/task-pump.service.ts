// Görev pompasının üretim sürücüsü.
//
// NEDEN VAR: motor kayıtlıydı ve /runtime 'enabled' diyordu, ama kuyruğa
// düşen görevler sonsuza dek 'queued' kalıyordu — kuyruğu tüketip
// `orchestrate` çağıran hiçbir üretim kodu yoktu. Kayıt ≠ tüketim.
import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ackQueue, createRedis, ensureGroup, getLatestTask, queueKey, readQueue, reclaimQueue } from '@ww/db';
import { getActivePrompt } from '@ww/db';
import { EntityIdSchema, type EntityId } from '@ww/shared';
import type { WwRedis } from '@ww/db';
import { PHASE8_RUNTIME } from './runtime-composition.js';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';
import { pumpOnce, type PumpItem } from './task-pump.js';

export const TASK_PUMP_INTERVAL_MS = 3_000;
const PUMP_GROUP = 'scheduler';
const WORKER_PROMPT = 'role.worker.coding';
const VERIFIER_PROMPT = 'role.verifier';
// Çöken/yeniden başlayan bir tüketicinin üzerinde kalan mesaj bu süre sonunda
// devralınır; reclaim olmazsa o iş sonsuza dek asılı kalır.
const RECLAIM_MIN_IDLE_MS = 30_000;
const MAX_DELIVERIES = 5;

/** Composition'ın pompanın ihtiyaç duyduğu dar yüzeyi. */
export interface PumpRuntime {
  taskBriefService: {
    seal(input: Readonly<{
      taskId: EntityId;
      workerPrompt: { name: string; version: number };
      verifierPrompt: { name: string; version: number };
      allowedTools: readonly string[];
      cutoffAt: string;
    }>): Promise<unknown>;
  };
  orchestrate(input: Readonly<{ taskId: EntityId; brief: unknown; maxAttempts: number }>): Promise<Readonly<{ status: string }>>;
}

@Injectable()
export class TaskPumpService implements OnModuleInit, OnModuleDestroy {
  readonly #logger = new Logger(TaskPumpService.name);
  readonly #database: ServerDatabase;
  readonly #runtime: PumpRuntime | null;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  #redis: Promise<WwRedis> | undefined;
  #reclaimCursor = '0-0';

  constructor(
    @Inject(SERVER_DATABASE) database: ServerDatabase,
    @Optional() @Inject(PHASE8_RUNTIME) runtime: PumpRuntime | null,
  ) {
    this.#database = database;
    this.#runtime = runtime ?? null;
  }

  onModuleInit(): void {
    // Pompanın KAPALI olması sessiz kalmamalı: kuyruk dolarken sebebi
    // görünmezse "motor etkin ama hiçbir şey olmuyor" tablosuna geri dönülür.
    if (this.#runtime === null) {
      this.#logger.warn('görev pompası açılmadı: orkestrasyon runtime kayıtlı değil');
      return;
    }
    if (process.env['WW_DISABLE_TASK_PUMP'] === '1') {
      this.#logger.log('görev pompası WW_DISABLE_TASK_PUMP=1 ile kapatıldı');
      return;
    }
    const projectId = process.env['WW_RUNTIME_PROJECT_ID'];
    if (projectId === undefined || projectId.trim() === '') {
      this.#logger.warn('görev pompası açılmadı: WW_RUNTIME_PROJECT_ID ayarlı değil');
      return;
    }
    this.#timer = setInterval(() => { void this.pump(projectId); }, TASK_PUMP_INTERVAL_MS);
    this.#timer.unref?.();
    this.#logger.log(`görev pompası açık — proje ${projectId}`);
    void this.pump(projectId);
  }

  onModuleDestroy(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Tek tur. Üst üste binmeyi engeller: aynı görev iki kez koşarsa iş bozulur. */
  async pump(projectIdValue: string): Promise<void> {
    if (this.#running) return;
    const runtime = this.#runtime;
    if (runtime === null) return;
    this.#running = true;
    try {
      const projectId = EntityIdSchema.parse(projectIdValue);
      // Bağlantıyı sessizce atlamak, pompayı görünmez biçimde ölü bırakırdı.
      const redis = await this.#connect();
      const stream = queueKey(projectId);
      await ensureGroup(redis, stream, PUMP_GROUP);

      const result = await pumpOnce({
        claim: async () => this.#claim(projectId),
        ack: async (msgId) => { await ackQueue(redis, stream, PUMP_GROUP, msgId); },
        seal: async (taskId) => this.#seal(runtime, projectId, taskId) as never,
        orchestrate: (input) => runtime.orchestrate(input),
        onResult: (taskId, status) => this.#logger.log(`görev ${taskId}: ${status}`),
        onError: (taskId, reason) => this.#logger.warn(`görev ${taskId} işlenemedi: ${String(reason)}`),
      });
      if (result.processed > 0) this.#logger.log(`pompa turu: ${result.processed} görev`);
    } catch (reason) {
      // Pompa turu hatası sunucuyu düşürmemeli ama sessiz de kalmamalı.
      this.#logger.warn(`görev pompası turu başarısız: ${String(reason)}`);
    } finally {
      this.#running = false;
    }
  }

  #connect(): Promise<WwRedis> {
    this.#redis ??= this.#database.redis === undefined
      ? createRedis()
      : Promise.resolve(this.#database.redis);
    return this.#redis;
  }

  async #claim(projectId: EntityId): Promise<readonly PumpItem[]> {
    const redis = await this.#connect();
    const stream = queueKey(projectId);
    const consumer = `pump-${process.pid}`;

    // ÖNCE terk edilmiş iş: sunucu yeniden başladığında önceki tüketicinin
    // üzerinde kalan mesajlar aksi halde hiç işlenmez.
    const reclaim = await reclaimQueue(redis, stream, PUMP_GROUP, consumer, {
      minIdleMs: RECLAIM_MIN_IDLE_MS,
      maxDeliveries: MAX_DELIVERIES,
      cursor: this.#reclaimCursor,
      count: 5,
    });
    this.#reclaimCursor = reclaim.nextCursor;
    for (const dead of reclaim.exhausted) {
      // Teslim sınırını aşan iş sessizce dönüp durmamalı; görünür olmalı.
      this.#logger.warn(`görev ${dead.taskId} teslim sınırını aştı — otomatik denenmeyecek`);
    }

    const read = await readQueue(redis, stream, PUMP_GROUP, consumer, { count: 5 });
    // Bozuk çerçeve sessizce düşerse kuyruğun neden tıkandığı görünmez olur.
    for (const bad of [...reclaim.invalid, ...read.invalid]) {
      this.#logger.warn(`kuyrukta geçersiz mesaj ${bad.msgId}: okunamadı`);
    }
    return [...reclaim.claimed, ...read.messages].map((message) => ({
      msgId: message.msgId,
      taskId: EntityIdSchema.parse(message.taskId),
    }));
  }

  // Brief atama anında MÜHÜRLENİR: prompt sürümü o an sabitlenir, sonradan
  // prompt değişse bile bu görev aynı girdiyle çalışmış sayılır.
  async #seal(runtime: PumpRuntime, projectId: EntityId, taskId: EntityId): Promise<unknown> {
    // KARARLI cutoff: her turda `now()` kullanmak her denemede YENİ bir brief
    // mühürlüyordu. İkinci tur, ilk turun attempt'ine bağlı olmayan bir brief
    // üretiyor ve rapor "task brief uyusmuyor" ile reddediliyordu.
    const task = await getLatestTask(this.#database.ch, projectId, taskId);
    if (task === null) throw new Error(`görev bulunamadı: ${taskId}`);
    const cutoffAt = task.created_at;

    const [worker, verifier] = await Promise.all([
      getActivePrompt(this.#database.ch, WORKER_PROMPT),
      getActivePrompt(this.#database.ch, VERIFIER_PROMPT),
    ]);
    if (worker === null) throw new Error(`aktif prompt yok: ${WORKER_PROMPT}`);
    if (verifier === null) throw new Error(`aktif prompt yok: ${VERIFIER_PROMPT}`);

    return runtime.taskBriefService.seal({
      taskId,
      workerPrompt: { name: worker.prompt_name, version: worker.prompt_version },
      verifierPrompt: { name: verifier.prompt_name, version: verifier.prompt_version },
      allowedTools: ['read_file', 'write_file', 'list_dir', 'git_diff'],
      cutoffAt,
    });
  }
}
