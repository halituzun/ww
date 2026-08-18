// Bir agent'ın geçmişi (docs/08 → tuval: "düğüme tık → yan panelde agent
// geçmişi: görevleri, mesajları, harcadığı token").
//
// NEDEN VAR: bu yüzey dokümante ama hiç yazılmamıştı. Tuvalde bir agent'a
// tıklayınca gösterilecek hiçbir veri yoktu; "bu agent ne yaptı, ne harcadı"
// sorusunun cevabı yalnızca ham SQL ile alınabiliyordu.
import type { ClickHouseClient } from '../client.js';
import { concreteEntityId } from './identifiers.js';

export interface AgentTaskSummary {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  /** Bu agent görevde hangi rolde: iş veren, yapan ya da denetleyen. */
  readonly relation: 'issuer' | 'worker' | 'verifier';
}

export interface AgentActivity {
  readonly agentId: string;
  readonly tasks: readonly AgentTaskSummary[];
  readonly messageCount: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costUsd: number;
  readonly calls: number;
}

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export async function readAgentActivity(
  ch: ClickHouseClient,
  projectId: string,
  agentId: string,
): Promise<AgentActivity> {
  const project = concreteEntityId(projectId, 'projectId');
  const agent = concreteEntityId(agentId, 'agentId');

  const taskRows = await (await ch.query({
    query: `SELECT task_id, title, status, relation FROM (
        SELECT task_id,
          argMax(title, version) AS title,
          argMax(status, version) AS status,
          argMax(issuer_agent_id, version) AS issuer,
          argMax(worker_agent_id, version) AS worker,
          argMax(verifier_agent_id, version) AS verifier
        FROM tasks WHERE project_id = {projectId:UUID} GROUP BY task_id
      )
      ARRAY JOIN [
        if(issuer = {agentId:UUID}, 'issuer', ''),
        if(worker = {agentId:UUID}, 'worker', ''),
        if(verifier = {agentId:UUID}, 'verifier', '')
      ] AS relation
      WHERE relation != ''
      ORDER BY task_id`,
    query_params: { projectId: project, agentId: agent },
    format: 'JSONEachRow',
  })).json<Record<string, unknown>>();

  const usageRow = (await (await ch.query({
    query: `SELECT
        sum(prompt_tokens) AS prompt_tokens,
        sum(completion_tokens) AS completion_tokens,
        sum(cost_usd) AS cost_usd,
        count() AS calls
      FROM api_usage WHERE project_id = {projectId:UUID} AND agent_id = {agentId:UUID}`,
    query_params: { projectId: project, agentId: agent },
    format: 'JSONEachRow',
  })).json<Record<string, unknown>>())[0] ?? {};

  const messageRow = (await (await ch.query({
    query: `SELECT count() AS total FROM messages
      WHERE project_id = {projectId:UUID} AND from_agent_id = {agentId:UUID}`,
    query_params: { projectId: project, agentId: agent },
    format: 'JSONEachRow',
  })).json<Record<string, unknown>>())[0] ?? {};

  return Object.freeze({
    agentId: agent,
    tasks: Object.freeze(taskRows.map((row) => Object.freeze({
      taskId: String(row['task_id']),
      title: String(row['title'] ?? ''),
      status: String(row['status'] ?? ''),
      relation: String(row['relation']) as AgentTaskSummary['relation'],
    }))),
    messageCount: num(messageRow['total']),
    promptTokens: num(usageRow['prompt_tokens']),
    completionTokens: num(usageRow['completion_tokens']),
    costUsd: num(usageRow['cost_usd']),
    calls: num(usageRow['calls']),
  });
}
