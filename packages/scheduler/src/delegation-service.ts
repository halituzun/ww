import {
  createTask,
  sumTaskTokensSpent,
  type ClickHouseClient,
  type TaskRow,
} from '@ww/db';
import { randomUUID } from 'node:crypto';
import { NIL_UUID, type AgentGroup, type EntityId } from '@ww/shared';

export class DelegationError extends Error {
  constructor(message: string) { super(message); this.name = 'DelegationError'; }
}

export interface CreateSubtaskInput {
  readonly parentTaskId: EntityId;
  readonly issuerAgentId: EntityId;
  readonly title: string;
  readonly description?: string;
  readonly acceptanceCriteria: readonly string[];
  readonly targetFiles: readonly string[];
  readonly group: AgentGroup;
  readonly budget: number;
  readonly dependencies?: readonly EntityId[];
  readonly maxDepth?: number;
  readonly maxBudget?: number;
}

/** Scheduler-owned delegation guard. Every subtask remains a normal durable task. */
export class DelegationService {
  readonly #ch: ClickHouseClient;
  constructor(ch: ClickHouseClient) { this.#ch = ch; }

  async createSubtask(input: CreateSubtaskInput): Promise<TaskRow> {
    // The project is read from the parent task; this keeps delegation scoped
    // even when the caller only has a parent task id.
    const parentRows = await this.#ch.query({
      query: `SELECT task_id, project_id, plan_id, parent_task_id, delegation_depth, token_budget, tokens_spent, issuer_agent_id
        FROM tasks WHERE task_id = {taskId:UUID} ORDER BY version DESC LIMIT 1`,
      query_params: { taskId: input.parentTaskId },
      format: 'JSONEachRow',
    });
    const rows = await parentRows.json<Record<string, unknown>>();
    if (rows.length === 0) throw new DelegationError(`parent task bulunamadi: ${input.parentTaskId}`);
    const raw = rows[0]!;
    const projectId = String(raw['project_id']) as EntityId;
    const depth = Number(raw['delegation_depth']);
    const budget = Number(raw['token_budget']);
    // HARCAMA KOLONDAN DEĞİL, api_usage'DAN. `tasks.tokens_spent` üretimde
    // hep 0'dır (tek yazıcısı görev açılışıdır), yani "alt görev parent'ın
    // KALAN bütçesini aşamaz" kuralı fiilen "TOPLAM bütçesini aşamaz"a
    // dönüşüyordu: bütçesini bitirmiş bir görev her alt göreve bütçenin
    // tamamını dağıtabilirdi.
    const spent = await sumTaskTokensSpent(this.#ch, input.parentTaskId);
    const maxDepth = input.maxDepth ?? 3;
    if (!Number.isSafeInteger(depth) || depth >= maxDepth) throw new DelegationError('delegation depth limiti asildi');
    if (!Number.isSafeInteger(spent) || spent < 0 || spent > budget) throw new DelegationError('parent token harcamasi gecersiz');
    if (!Number.isSafeInteger(input.budget) || input.budget < 0 || input.budget > budget - spent) throw new DelegationError('subtask budget parent kalan butcesini asiyor');
    const ancestors = new Set<string>([input.parentTaskId]);
    let ancestor = String(raw['parent_task_id'] ?? NIL_UUID);
    for (let depthGuard = 0; ancestor !== NIL_UUID && depthGuard < 64; depthGuard += 1) {
      if (ancestors.has(ancestor)) throw new DelegationError('delegation parent cycle');
      ancestors.add(ancestor);
      const ancestorResult = await this.#ch.query({ query: `SELECT parent_task_id FROM tasks WHERE project_id = {projectId:UUID} AND task_id = {taskId:UUID} ORDER BY version DESC LIMIT 1`, query_params: { projectId, taskId: ancestor }, format: 'JSONEachRow' });
      const ancestorRows = await ancestorResult.json<Record<string, unknown>>();
      if (ancestorRows.length === 0) throw new DelegationError(`ancestor task bulunamadi: ${ancestor}`);
      ancestor = String(ancestorRows[0]!['parent_task_id'] ?? NIL_UUID);
    }
    if (ancestor !== NIL_UUID) throw new DelegationError('delegation ancestor derinligi asildi');
    const dependencies = [...new Set(input.dependencies ?? [])];
    for (const dependency of dependencies) {
      const dependencyResult = await this.#ch.query({ query: `SELECT parent_task_id, project_id FROM tasks WHERE task_id = {taskId:UUID} ORDER BY version DESC LIMIT 1`, query_params: { taskId: dependency }, format: 'JSONEachRow' });
      const dependencyRows = await dependencyResult.json<Record<string, unknown>>();
      if (dependencyRows.length === 0) throw new DelegationError(`dependency task bulunamadi: ${dependency}`);
      if (String(dependencyRows[0]!['project_id']) !== projectId) throw new DelegationError('dependency farkli projeye ait');
      if (ancestors.has(dependency)) throw new DelegationError('delegation dependency cycle');
    }
    // ALT GÖREV PARENT'IN PLANINI DEVRALIR. Eskiden `plan_id: NIL_UUID` SABİT
    // yazılıydı: plansız görev atamada reddedilir, yani docs/03'ün çekirdek
    // yeteneği olan `create_subtask` ile açılan HER alt görev doğuştan
    // koşamaz durumdaydı — hem de sessizce, `queued` görünerek.
    //
    // Kontrol bütçe/soy ağacı kontrollerinden SONRA yapılır: onlar daha
    // özgül hatalardır ve önce raporlanmaları çağırana daha çok şey anlatır.
    const planId = String(raw['plan_id'] ?? NIL_UUID);
    if (planId === '' || planId === NIL_UUID) {
      // Sessizce açmak, koşamayacak bir görev yaratmaktır.
      throw new DelegationError(
        `parent task plan kimligi tasimiyor, alt gorev acilamaz: ${input.parentTaskId}`,
      );
    }

    const now = new Date().toISOString();
    return createTask(this.#ch, {
      task_id: randomUUID() as EntityId,
      project_id: projectId,
      plan_id: planId as EntityId,
      parent_task_id: input.parentTaskId,
      title: input.title,
      description: input.description ?? '',
      acceptance_criteria: [...input.acceptanceCriteria],
      status: 'queued',
      priority: 5,
      issuer_agent_id: input.issuerAgentId,
      worker_agent_id: NIL_UUID,
      verifier_agent_id: NIL_UUID,
      group: input.group,
      depends_on: dependencies,
      target_files: [...input.targetFiles],
      attempt: 0,
      max_attempts: 3,
      delegation_depth: depth + 1,
      token_budget: input.budget,
      tokens_spent: '0',
      commit_hash: '',
      result_summary: '',
      reject_reason: '',
      task_brief_id: NIL_UUID,
      assignment_attempt_id: NIL_UUID,
      created_at: now,
      updated_at: now,
    });
  }
}
