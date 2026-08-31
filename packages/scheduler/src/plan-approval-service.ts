import {
  appendPlanVersion,
  createTask,
  listLatestAgents,
  listLatestPlansByStatus,
  listLatestTasks,
  type ClickHouseClient,
  type PlanRow,
  type TaskRow,
} from '@ww/db';
import {
  NIL_UUID,
  readPlanTaskGraph,
  topologicalPlanTaskOrder,
  type AgentGroup,
  type EntityId,
  type PlanTaskSpecV1,
} from '@ww/shared';

export class PlanApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanApprovalError';
  }
}

export interface PlanApprovalInput {
  readonly projectId: EntityId;
  readonly planId: EntityId;
  readonly approved: boolean;
  readonly actor: string;
  readonly now: string;
  readonly note?: string;
}

export interface PlanApprovalResult {
  readonly plan: PlanRow;
  /** Onayın ÜRETTİĞİ görevler. Panel bu sayıyı olduğu gibi söyler. */
  readonly createdTasks: readonly TaskRow[];
}

/**
 * Görevi kuyruğa basan dış bağımlılık. NEDEN port: scheduler paketi Redis'i
 * doğrudan kablolamaz ve testler kuyruk olmadan koşabilmelidir.
 */
export interface PlanTaskEnqueuePort {
  enqueue(projectId: EntityId, taskId: EntityId): Promise<void>;
}

export interface PlanApprovalDeps {
  readonly newTaskId: () => EntityId;
}

/**
 * Plan onayı.
 *
 * NEDEN YENİDEN YAZILDI: bu servis yalnızca `status`'ü `approved` yapıyordu.
 * Plandan görev türeten HİÇBİR kod yoktu; buna karşılık panel onaydan sonra
 * "Görev planı onaylandı. Görevler yürütmeye alındı." diyordu. Kuyruk boş
 * kalıyor, kullanıcı bekliyordu.
 *
 * Onay artık bir DURUM DEĞİŞİKLİĞİ değil, bir ÜRETİM İŞLEMİDİR: planın görev
 * grafiği okunur, bağımlılık sırasına göre görevler açılır ve kuyruğa basılır.
 * Grafik yoksa onay REDDEDİLİR — "onaylandı ama hiçbir şey olmadı" durumu
 * artık mümkün değildir.
 */
export class PlanApprovalService {
  readonly #ch: ClickHouseClient;
  readonly #enqueue: PlanTaskEnqueuePort;
  readonly #newTaskId: () => EntityId;

  constructor(ch: ClickHouseClient, enqueue: PlanTaskEnqueuePort, deps: PlanApprovalDeps) {
    this.#ch = ch;
    this.#enqueue = enqueue;
    this.#newTaskId = deps.newTaskId;
  }

  async apply(input: PlanApprovalInput): Promise<PlanApprovalResult> {
    const plan = await this.#findPlan(input.projectId, input.planId);

    if (plan.status !== 'debating' && plan.status !== 'proposed') {
      if (input.approved && plan.status === 'approved') {
        // Yeniden onay idempotenttir: görev üretmez, mevcut planı döner.
        return { plan, createdTasks: [] };
      }
      if (!input.approved && plan.status === 'rejected') return { plan, createdTasks: [] };
      throw new PlanApprovalError('plan bu durumda onaylanamaz');
    }

    if (!input.approved) {
      const rejected = await this.#writeStatus(plan, 'rejected', '', input.note);
      return { plan: rejected, createdTasks: [] };
    }

    // ÖNCE görev grafiğini doğrula, SONRA statüyü çevir. Ters sırada plan
    // "approved" kalır ama hiçbir görev doğmaz — düzeltmeye çalıştığımız
    // yalanın ta kendisi.
    const graph = readPlanTaskGraph(plan.scenarios_json);
    if (graph.tasks.length === 0) {
      throw new PlanApprovalError(
        'plan gorev kirilimi tasimiyor: onay hicbir gorev uretemez. '
        + 'Konseyin nihai sentezinde "## GÖREVLER" bolumu yok ya da okunamadi.',
      );
    }
    const ordered = topologicalPlanTaskOrder(graph.tasks);

    const approved = await this.#writeStatus(plan, 'approved', input.actor, input.note);
    const createdTasks = await this.#createTasks(approved, ordered, input.now);
    return { plan: approved, createdTasks };
  }

  async #findPlan(projectId: EntityId, planId: EntityId): Promise<PlanRow> {
    const candidates = await Promise.all(
      (['debating', 'proposed', 'approved', 'rejected'] as const).map((status) =>
        listLatestPlansByStatus(this.#ch, projectId, status),
      ),
    );
    const plan = candidates.flat().find((row) => row.plan_id === planId);
    if (plan === undefined) throw new PlanApprovalError('plan bulunamadi');
    return plan;
  }

  #writeStatus(
    plan: PlanRow,
    status: 'approved' | 'rejected',
    actor: string,
    note: string | undefined,
  ): Promise<PlanRow> {
    const next: Omit<PlanRow, 'version' | 'observed_at'> = {
      ...plan,
      status,
      approved_by: actor,
      // NOT: onay notu ile yeniden planlama gerekçesi aynı kolonu paylaşıyor.
      // Bilinen kusur; ayrı kolon Faz B7 ile gelecek.
      replan_reason: note ?? plan.replan_reason,
    };
    return appendPlanVersion(this.#ch, { expectedVersion: plan.version, next });
  }

  async #createTasks(
    plan: PlanRow,
    ordered: readonly PlanTaskSpecV1[],
    now: string,
  ): Promise<readonly TaskRow[]> {
    const agents = await listLatestAgents(this.#ch, plan.project_id);
    const issuer = agents.find((agent) => agent.role === 'pm' && agent.status !== 'stopped')
      ?? agents.find((agent) => agent.status !== 'stopped');
    if (issuer === undefined) {
      throw new PlanApprovalError('proje icin aktif issuer agent bulunamadi');
    }

    // Aynı planı iki kez onaylamak mükerrer görev açmasın: açık başlıklar
    // tekilleştirilir (mevcut görev oluşturma yolundaki kalkanın aynısı).
    const existing = await listLatestTasks(this.#ch, plan.project_id);
    const openTitles = new Map(
      existing
        .filter((task) => task.status === 'queued' || task.status === 'working'
          || task.status === 'verifying' || task.status === 'testing')
        .map((task) => [task.title.trim().toLocaleLowerCase('tr-TR'), task]),
    );

    const idByKey = new Map<string, EntityId>();
    const created: TaskRow[] = [];

    for (const spec of ordered) {
      const duplicate = openTitles.get(spec.title.trim().toLocaleLowerCase('tr-TR'));
      if (duplicate !== undefined) {
        idByKey.set(spec.key, duplicate.task_id as EntityId);
        continue;
      }

      const taskId = this.#newTaskId();
      const dependsOn = spec.dependsOn.map((key) => {
        const resolved = idByKey.get(key);
        if (resolved === undefined) {
          // Topolojik sıralama bunu imkânsız kılar; yine de sessiz kalmayız.
          throw new PlanApprovalError(`gorev bagimliligi cozulemedi: ${spec.key} -> ${key}`);
        }
        return resolved;
      });

      const task = await createTask(this.#ch, {
        task_id: taskId,
        project_id: plan.project_id,
        plan_id: plan.plan_id,
        parent_task_id: NIL_UUID,
        title: spec.title,
        description: spec.description,
        acceptance_criteria: [...spec.acceptanceCriteria],
        status: 'queued',
        priority: 5,
        issuer_agent_id: issuer.agent_id,
        worker_agent_id: NIL_UUID,
        verifier_agent_id: NIL_UUID,
        group: spec.group as AgentGroup,
        depends_on: dependsOn,
        // Hedef dosyalar sözleşme gereği BOŞ OLAMAZ (bkz. plan-tasks.ts):
        // boş liste executor'da write_file'ı reddettirir.
        target_files: [...spec.targetFiles],
        attempt: 0,
        max_attempts: 3,
        delegation_depth: 0,
        token_budget: 0,
        tokens_spent: '0',
        commit_hash: '',
        result_summary: '',
        reject_reason: '',
        task_brief_id: NIL_UUID,
        assignment_attempt_id: NIL_UUID,
        created_at: now,
        updated_at: now,
      } as never);

      idByKey.set(spec.key, task.task_id as EntityId);
      created.push(task);
      await this.#enqueue.enqueue(plan.project_id as EntityId, task.task_id as EntityId);
    }

    return Object.freeze(created);
  }
}
