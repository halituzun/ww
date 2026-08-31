import {
  appendPlanVersion,
  appendTaskVersion,
  listLatestPlansByStatus,
  listLatestTasks,
  type ClickHouseClient,
  type PlanRow,
  type TaskRow,
} from '@ww/db';
import { type EntityId } from '@ww/shared';

export class ReplanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplanningError';
  }
}

export interface ReplanInput {
  readonly projectId: EntityId;
  readonly reason: string;
  readonly summary: string;
  readonly now: string;
}

export interface ReplanResult {
  /** Devre dışı bırakılan plan (artık `superseded`). */
  readonly supersededPlan: PlanRow;
  /** İptal edilen, henüz bitmemiş görevler. */
  readonly cancelledTasks: readonly TaskRow[];
  /**
   * Yeni planın konsey turuna verilecek hedef. Çağıran taraf konseyi bu
   * metinle koşturur; yeni plan sürümü oradan doğar.
   */
  readonly councilGoal: string;
  /** Yeni planın taşıyacağı sürüm. */
  readonly nextPlanVersion: number;
}

/** Henüz sonuçlanmamış görev durumları; yeniden planlamada iptal edilirler. */
const OPEN_TASK_STATUSES = new Set([
  'queued', 'working', 'verifying', 'testing', 'rejected', 'waiting_user', 'escalated',
]);

/**
 * Yeniden planlama.
 *
 * NEDEN YENİDEN YAZILDI: eski servis aktif planın KOPYASINA `## Replan`
 * metnini ekleyip `replan_reason` yazmakla yetiniyordu. docs/03'ün yeniden
 * planlama sözleşmesinin HİÇBİR maddesi uygulanmıyordu:
 * `plan_version` artmıyor, statü `approved` kalıyor (kullanıcı onayına
 * dönmüyor), etkilenen görevler `cancelled` yapılmıyor, konsey turu
 * tetiklenmiyordu. Buna karşılık panel "Yeniden planlama talebi PM agent'a
 * iletildi." diyordu — PM'e hiçbir mesaj gitmiyordu.
 *
 * Artık: aktif plan `superseded` olur, açık görevler `cancelled` yapılır ve
 * çağıran tarafa yeni konsey turunun hedefi döndürülür. Yeni plan sürümü o
 * turdan doğar ve kullanıcı onayına `proposed` olarak gelir.
 *
 * Konsey turu BURADA koşulmaz: turlar gerçek model çağrısıdır ve dakikalar
 * sürer; bir HTTP isteğinin içinde beklemek isteği kilitler ve konsey
 * düşerse iptal işlemini de başarısız gösterirdi.
 */
export class ReplanningService {
  readonly #ch: ClickHouseClient;

  constructor(ch: ClickHouseClient) {
    this.#ch = ch;
  }

  async replan(input: ReplanInput): Promise<ReplanResult> {
    const reason = input.reason.trim();
    const summary = input.summary.trim();
    if (reason === '') throw new ReplanningError('yeniden planlama gerekcesi bos olamaz');

    const candidates = await Promise.all(
      (['debating', 'proposed', 'approved'] as const).map((status) =>
        listLatestPlansByStatus(this.#ch, input.projectId, status),
      ),
    );
    const current = candidates.flat()
      .sort((left, right) => right.observed_at.localeCompare(left.observed_at))[0] ?? null;
    if (current === null) throw new ReplanningError('aktif plan bulunamadi');

    // ÖNCE görevler durdurulur: plan devre dışı kalırken kuyruğun çalışmaya
    // devam etmesi, iptal edilen planın işini üretmek demektir.
    const cancelledTasks = await this.#cancelOpenTasks(current, input.now);

    const supersededPlan = await appendPlanVersion(this.#ch, {
      expectedVersion: current.version,
      next: {
        ...current,
        status: 'superseded',
        replan_reason: reason,
        created_at: current.created_at,
      },
    });

    return Object.freeze({
      supersededPlan,
      cancelledTasks,
      councilGoal: summary === '' ? reason : `${reason}\n\n${summary}`,
      nextPlanVersion: current.plan_version + 1,
    });
  }

  async #cancelOpenTasks(plan: PlanRow, now: string): Promise<readonly TaskRow[]> {
    const tasks = await listLatestTasks(this.#ch, plan.project_id);
    const open = tasks.filter(
      (task) => task.plan_id === plan.plan_id && OPEN_TASK_STATUSES.has(task.status),
    );

    const cancelled: TaskRow[] = [];
    for (const task of open) {
      cancelled.push(await appendTaskVersion(this.#ch, {
        expectedVersion: task.version,
        next: {
          ...task,
          status: 'cancelled',
          // Sebep görünür kalmalı: görevin neden durduğu, plan geçmişine
          // bakmadan anlaşılabilmeli.
          reject_reason: 'plan yeniden planlandi',
          updated_at: now,
        },
      }));
    }
    return Object.freeze(cancelled);
  }
}
