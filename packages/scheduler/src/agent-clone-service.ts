import {
  appendAgentVersion,
  appendEvent,
  createAgent,
  listLatestAgents,
  type AgentRow,
  type ClickHouseClient,
} from '@ww/db';
import { randomUUID } from 'node:crypto';
import { NIL_UUID, canonicalSha256V1, type EntityId } from '@ww/shared';

export class CloneLimitError extends Error {
  constructor(message: string) { super(message); this.name = 'CloneLimitError'; }
}

export interface CloneOptions { readonly maxClonesPerAgent?: number; readonly maxParallelAgents?: number; }

export class AgentCloneService {
  readonly #ch: ClickHouseClient;
  readonly #options: Required<CloneOptions>;
  constructor(ch: ClickHouseClient, options: CloneOptions = {}) {
    this.#ch = ch;
    this.#options = { maxClonesPerAgent: options.maxClonesPerAgent ?? 5, maxParallelAgents: options.maxParallelAgents ?? 8 };
  }

  async cloneIfBusy(projectId: EntityId, sourceAgentId: EntityId): Promise<AgentRow> {
    const agents = await listLatestAgents(this.#ch, projectId, { limit: 1_000 });
    const source = agents.find((agent) => agent.agent_id === sourceAgentId);
    if (source === undefined) throw new CloneLimitError(`clone source bulunamadi: ${sourceAgentId}`);
    const clones = agents.filter((agent) => agent.clone_of === sourceAgentId);
    if (clones.length >= this.#options.maxClonesPerAgent) throw new CloneLimitError('agent clone limiti asildi');
    if (agents.length >= this.#options.maxParallelAgents) throw new CloneLimitError('global agent limiti asildi');
    const cloneId = randomUUID() as EntityId;
    const now = new Date().toISOString();
    const clone = await createAgent(this.#ch, {
      agent_id: cloneId,
      project_id: projectId,
      role: source.role,
      group: source.group,
      name: `${source.name}-${clones.length + 1}`,
      model_ref: source.model_ref,
      parent_agent_id: source.parent_agent_id,
      clone_of: source.agent_id,
      status: 'idle',
      current_task_id: NIL_UUID,
      prompt_name: source.prompt_name,
      prompt_version: source.prompt_version,
      tasks_done: 0,
      tasks_rejected: 0,
      created_at: now,
      updated_at: now,
    });
    const hash = canonicalSha256V1({ projectId, sourceAgentId, cloneId });
    await appendEvent(this.#ch, {
      event_id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}` as EntityId,
      seq: String(BigInt(`0x${hash.slice(0, 15)}`)),
      project_id: projectId,
      task_id: NIL_UUID,
      agent_id: cloneId,
      event_type: 'clone_spawned',
      tool_name: 'scheduler.clone',
      payload: { sourceAgentId, cloneId },
      duration_ms: 0,
      created_at: now,
    });
    return clone;
  }

  async stopIdleClones(projectId: EntityId, olderThan: string): Promise<readonly EntityId[]> {
    const agents = await listLatestAgents(this.#ch, projectId, { limit: 1_000 });
    const stopped: EntityId[] = [];
    for (const agent of agents) {
      if (agent.clone_of === NIL_UUID || agent.status !== 'idle' || Date.parse(agent.updated_at) >= Date.parse(olderThan)) continue;
      await appendAgentVersion(this.#ch, {
        expectedVersion: agent.version,
        assignmentFence: String(BigInt(agent.assignment_fence) + 1n),
        next: { ...agent, status: 'stopped', current_task_id: NIL_UUID, updated_at: new Date().toISOString() },
      });
      stopped.push(agent.agent_id);
    }
    return stopped;
  }
}
