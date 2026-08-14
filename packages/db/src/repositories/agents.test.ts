import { randomUUID } from 'node:crypto';
import { NIL_UUID, canonicalSha256V1 } from '@ww/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh, type ClickHouseClient } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import {
  appendAgentVersion,
  createAgent,
  getLatestAgent,
  listLatestAgentsByStatus,
  type AgentRow,
  type CreateAgentInput,
} from './agents.js';
import { RepositoryConflictError } from './types.js';

const up = await clickhouseUp();

describe.skipIf(!up)('agents repository', () => {
  const db = `ww_test_agents_${Date.now()}_${process.pid}`;
  let ch: ClickHouseClient;

  const rowHash = (row: AgentRow): string => canonicalSha256V1([
    row.agent_id, row.project_id, row.role, row.group, row.name, row.model_ref,
    row.parent_agent_id, row.clone_of, row.status, row.current_task_id,
    row.prompt_name, row.prompt_version, row.tasks_done, row.tasks_rejected,
    row.created_at, row.updated_at, row.version,
  ]);

  beforeAll(async () => {
    await runMigrations({ database: db });
    ch = createCh({ database: db });
  });
  afterAll(async () => {
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin.close();
    await ch.close();
  });

  function agent(): CreateAgentInput {
    const now = new Date().toISOString();
    return {
      agent_id: randomUUID(),
      project_id: randomUUID(),
      role: 'worker',
      group: 'coding',
      name: 'Worker-Coding-1',
      model_ref: 'openai:gpt-test',
      parent_agent_id: NIL_UUID,
      clone_of: NIL_UUID,
      status: 'idle',
      current_task_id: NIL_UUID,
      prompt_name: 'role.worker.coding',
      prompt_version: 2,
      tasks_done: 0,
      tasks_rejected: 0,
      created_at: now,
      updated_at: now,
    };
  }

  it('legacy nil alanlarini korur, append eder ve latest statusu filtreler', async () => {
    const initial = await createAgent(ch, agent());
    expect(initial.parent_agent_id).toBe(NIL_UUID);
    expect(initial.current_task_id).toBe(NIL_UUID);
    const busy = await appendAgentVersion(ch, {
      expectedVersion: initial.version,
      next: { ...initial, status: 'busy', current_task_id: randomUUID() },
    });
    expect((await getLatestAgent(ch, initial.project_id, initial.agent_id))?.version).toBe(busy.version);
    expect(await listLatestAgentsByStatus(ch, initial.project_id, 'idle')).toEqual([]);
    expect((await listLatestAgentsByStatus(ch, initial.project_id, 'busy'))[0]?.agent_id).toBe(
      initial.agent_id,
    );
  });

  it('max surum retry kopyasini katlar ve divergent tie kaydini fail-closed reddeder', async () => {
    const initial = await createAgent(ch, agent());
    await ch.insert({
      table: 'agents',
      values: [{ ...initial, row_hash: rowHash(initial) }],
      format: 'JSONEachRow',
    });
    expect(await getLatestAgent(ch, initial.project_id, initial.agent_id)).toEqual(initial);

    const divergent = { ...initial, name: 'divergent' };
    await ch.insert({
      table: 'agents',
      values: [{ ...divergent, row_hash: rowHash(divergent) }],
      format: 'JSONEachRow',
    });
    await ch.command({ query: 'OPTIMIZE TABLE agents FINAL' });
    await expect(getLatestAgent(ch, initial.project_id, initial.agent_id))
      .rejects.toBeInstanceOf(RepositoryConflictError);
    await expect(listLatestAgentsByStatus(ch, initial.project_id, initial.status))
      .rejects.toBeInstanceOf(RepositoryConflictError);
  });
});
