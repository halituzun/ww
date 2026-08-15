import {
  createTask,
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
      query: `SELECT task_id, project_id, delegation_depth, token_budget, tokens_spent, issuer_agent_id
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
    const maxDepth = input.maxDepth ?? 3;
    if (!Number.isSafeInteger(depth) || depth >= maxDepth) throw new DelegationError('delegation depth limiti asildi');
    if (!Number.isSafeInteger(input.budget) || input.budget < 0 || input.budget > budget) throw new DelegationError('subtask budget parent kalan butcesini asiyor');
    if (input.dependencies?.includes(input.parentTaskId)) throw new DelegationError('delegation dependency cycle');
    const dependencies = [...new Set(input.dependencies ?? [])];
    for (const dependency of dependencies) {
      const dependencyResult = await this.#ch.query({ query: `SELECT parent_task_id FROM tasks WHERE task_id = {taskId:UUID} ORDER BY version DESC LIMIT 1`, query_params: { taskId: dependency }, format: 'JSONEachRow' });
      const dependencyRows = await dependencyResult.json<Record<string, unknown>>();
      if (dependencyRows.length === 0) throw new DelegationError(`dependency task bulunamadi: ${dependency}`);
    }
    const now = new Date().toISOString();
    return createTask(this.#ch, {
      task_id: randomUUID() as EntityId,
      project_id: projectId,
      plan_id: NIL_UUID,
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
