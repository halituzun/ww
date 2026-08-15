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
  listLatestAgents,
  listLatestAgentsByStatus,
  type AgentRow,
  type CreateAgentInput,
} from './agents.js';
import { RepositoryConflictError, StoredRecordError } from './types.js';

const up = await clickhouseUp();

describe('agents repository query shape', () => {
  it('agent gecmisini uygulamaya tasimadan SQL icinde max versiona indirger', async () => {
    const queries: string[] = [];
    const fakeCh = {
      query: async (options: { readonly query: string }) => {
        queries.push(options.query);
        return { json: async () => [] };
      },
    } as unknown as ClickHouseClient;
    const projectId = randomUUID();

    await getLatestAgent(fakeCh, projectId, randomUUID());
    await listLatestAgents(fakeCh, projectId);
    await listLatestAgentsByStatus(fakeCh, projectId, 'idle');

    expect(queries[0]).toMatch(/version = \(\s*SELECT max\(version\) FROM agents/);
    expect(queries[1]).toMatch(
      /\(agent_id, version\) IN \(\s*SELECT agent_id, max\(version\) FROM agents/,
    );
    expect(queries[1]).toMatch(/GROUP BY agent_id/);
    expect(queries[2]).toMatch(
      /\(agent_id, version\) IN \(\s*SELECT agent_id, max\(version\) FROM agents/,
    );
    expect(queries[2]).toMatch(/GROUP BY agent_id/);
  });
});

describe.skipIf(!up)('agents repository', () => {
  const db = `ww_test_agents_${Date.now()}_${process.pid}`;
  let ch: ClickHouseClient;

  const rowHash = (row: AgentRow): string => canonicalSha256V1([
    row.agent_id, row.project_id, row.role, row.group, row.name, row.model_ref,
    row.parent_agent_id, row.clone_of, row.status, row.current_task_id,
    row.prompt_name, row.prompt_version, row.tasks_done, row.tasks_rejected,
    row.created_at, row.updated_at, row.assignment_fence, row.version,
  ]);

  const legacyRowHash = (row: AgentRow): string => canonicalSha256V1([
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

  function agent(overrides: Partial<CreateAgentInput> = {}): CreateAgentInput {
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
      ...overrides,
    };
  }

  it('project agent snapshotini latest surumde deterministik ve bounded dondurur', async () => {
    const projectId = randomUUID();
    const first = await createAgent(ch, agent({ project_id: projectId, name: 'Worker-A' }));
    const secondInitial = await createAgent(ch, agent({
      project_id: projectId,
      name: 'Worker-B',
    }));
    const third = await createAgent(ch, agent({ project_id: projectId, name: 'Worker-C' }));
    const second = await appendAgentVersion(ch, {
      expectedVersion: secondInitial.version,
      assignmentFence: '1',
      next: { ...secondInitial, status: 'busy', current_task_id: randomUUID() },
    });
    await createAgent(ch, agent({ name: 'Other-Project' }));

    const expected = [first, second, third].sort((left, right) => (
      left.agent_id.localeCompare(right.agent_id)
    ));
    expect(await listLatestAgents(ch, projectId)).toEqual(expected);
    await expect(listLatestAgents(ch, projectId, { limit: 2 }))
      .rejects.toBeInstanceOf(RepositoryConflictError);
    await expect(listLatestAgents(ch, projectId, { limit: 0 }))
      .rejects.toBeInstanceOf(StoredRecordError);
    await expect(listLatestAgents(ch, projectId, { limit: 1_001 }))
      .rejects.toBeInstanceOf(StoredRecordError);
  });

  it('legacy nil alanlarini korur, append eder ve latest statusu filtreler', async () => {
    const initial = await createAgent(ch, agent());
    expect(initial.parent_agent_id).toBe(NIL_UUID);
    expect(initial.current_task_id).toBe(NIL_UUID);
    const busy = await appendAgentVersion(ch, {
      expectedVersion: initial.version,
      assignmentFence: '1',
      next: { ...initial, status: 'busy', current_task_id: randomUUID() },
    });
    expect((await getLatestAgent(ch, initial.project_id, initial.agent_id))?.version).toBe(busy.version);
    expect(await listLatestAgentsByStatus(ch, initial.project_id, 'idle')).toEqual([]);
    expect((await listLatestAgentsByStatus(ch, initial.project_id, 'busy'))[0]?.agent_id).toBe(
      initial.agent_id,
    );
  });

  it('max versionda en yuksek assignment fence kazanir ve OPTIMIZE sonrasi late stale insert yok sayilir', async () => {
    const initial = await createAgent(ch, agent());
    const busy = await appendAgentVersion(ch, {
      expectedVersion: initial.version,
      assignmentFence: '5',
      next: { ...initial, status: 'busy', current_task_id: randomUUID() },
    });
    await ch.command({ query: 'OPTIMIZE TABLE agents FINAL' });

    const lateStale = {
      ...busy,
      status: 'idle' as const,
      current_task_id: NIL_UUID,
      assignment_fence: '4',
    };
    await ch.insert({
      table: 'agents',
      values: [{ ...lateStale, row_hash: rowHash(lateStale) }],
      format: 'JSONEachRow',
    });
    await ch.command({ query: 'OPTIMIZE TABLE agents FINAL' });
    expect(await getLatestAgent(ch, initial.project_id, initial.agent_id)).toEqual(busy);
    expect(await listLatestAgentsByStatus(ch, initial.project_id, 'idle')).toEqual([]);
    expect((await listLatestAgentsByStatus(ch, initial.project_id, 'busy'))[0]).toEqual(busy);

    await expect(appendAgentVersion(ch, {
      expectedVersion: busy.version,
      assignmentFence: '3',
      next: { ...busy, status: 'idle', current_task_id: NIL_UUID },
    })).rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('stale expectedVersion yalniz durable fence caller fenceini kapsiyorsa exact retry olur', async () => {
    const initial = await createAgent(ch, agent());
    const taskId = randomUUID();
    const busy = await appendAgentVersion(ch, {
      expectedVersion: initial.version,
      assignmentFence: '8',
      next: { ...initial, status: 'busy', current_task_id: taskId },
    });

    await expect(appendAgentVersion(ch, {
      expectedVersion: initial.version,
      assignmentFence: '7',
      next: { ...initial, status: 'busy', current_task_id: taskId },
    })).resolves.toEqual(busy);
    await expect(appendAgentVersion(ch, {
      expectedVersion: initial.version,
      assignmentFence: '9',
      next: { ...initial, status: 'busy', current_task_id: taskId },
    })).rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('ayni max version ve assignment fence icindeki divergent tie kaydini reddeder', async () => {
    const initial = await createAgent(ch, agent());
    const busy = await appendAgentVersion(ch, {
      expectedVersion: initial.version,
      assignmentFence: '7',
      next: { ...initial, status: 'busy', current_task_id: randomUUID() },
    });
    const divergent = { ...busy, name: 'divergent-at-same-fence' };
    await ch.insert({
      table: 'agents',
      values: [{ ...divergent, row_hash: rowHash(divergent) }],
      format: 'JSONEachRow',
    });
    await ch.command({ query: 'OPTIMIZE TABLE agents FINAL' });
    await expect(getLatestAgent(ch, initial.project_id, initial.agent_id))
      .rejects.toBeInstanceOf(RepositoryConflictError);
    await expect(listLatestAgentsByStatus(ch, initial.project_id, 'busy'))
      .rejects.toBeInstanceOf(RepositoryConflictError);
    await expect(listLatestAgents(ch, initial.project_id))
      .rejects.toBeInstanceOf(RepositoryConflictError);
  });

  it('insert uzlastirmasinda yuksek fence yalniz ayni mantiksal icerikle kazanir', async () => {
    const initial = await createAgent(ch, agent());
    const taskId = randomUUID();
    let injected = false;
    const racingCh = {
      query: ch.query.bind(ch),
      insert: async (options: Parameters<ClickHouseClient['insert']>[0]) => {
        if (!injected && options.table === 'agents') {
          injected = true;
          const attempted = (options.values as readonly Record<string, unknown>[])[0]!;
          const winner = {
            ...attempted,
            assignment_fence: (BigInt(String(attempted['assignment_fence'])) + 1n).toString(),
          } as unknown as AgentRow;
          await ch.insert({
            table: 'agents',
            values: [{ ...winner, row_hash: rowHash(winner) }],
            format: 'JSONEachRow',
          });
        }
        return ch.insert(options);
      },
    } as unknown as ClickHouseClient;

    const reconciled = await appendAgentVersion(racingCh, {
      expectedVersion: initial.version,
      assignmentFence: '5',
      next: { ...initial, status: 'busy', current_task_id: taskId },
    });

    expect(reconciled.assignment_fence).toBe('6');
    expect(reconciled.current_task_id).toBe(taskId);
    expect((await getLatestAgent(ch, initial.project_id, initial.agent_id))?.assignment_fence)
      .toBe('6');
  });

  it('insert uzlastirmasinda yuksek fence farkli task icerigini typed conflict yapar', async () => {
    const initial = await createAgent(ch, agent());
    const intendedTaskId = randomUUID();
    const competingTaskId = randomUUID();
    let injected = false;
    const racingCh = {
      query: ch.query.bind(ch),
      insert: async (options: Parameters<ClickHouseClient['insert']>[0]) => {
        if (!injected && options.table === 'agents') {
          injected = true;
          const attempted = (options.values as readonly Record<string, unknown>[])[0]!;
          const winner = {
            ...attempted,
            assignment_fence: (BigInt(String(attempted['assignment_fence'])) + 1n).toString(),
            current_task_id: competingTaskId,
          } as unknown as AgentRow;
          await ch.insert({
            table: 'agents',
            values: [{ ...winner, row_hash: rowHash(winner) }],
            format: 'JSONEachRow',
          });
        }
        return ch.insert(options);
      },
    } as unknown as ClickHouseClient;

    await expect(appendAgentVersion(racingCh, {
      expectedVersion: initial.version,
      assignmentFence: '5',
      next: { ...initial, status: 'busy', current_task_id: intendedTaskId },
    })).rejects.toBeInstanceOf(RepositoryConflictError);
    expect((await getLatestAgent(ch, initial.project_id, initial.agent_id))?.current_task_id)
      .toBe(competingTaskId);
  });

  it('legacy assignment fence varsayimini ve eski row hashini sifir fence olarak okur', async () => {
    const input = agent();
    const logical: AgentRow = { ...input, assignment_fence: '0', version: '1' };
    await ch.insert({
      table: 'agents',
      values: [{ ...input, version: '1', row_hash: legacyRowHash(logical) }],
      format: 'JSONEachRow',
    });
    expect((await getLatestAgent(ch, input.project_id, input.agent_id))?.assignment_fence).toBe('0');
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
