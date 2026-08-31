import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCh, type ClickHouseClient } from '../client.js';
import { runMigrations } from '../migrate.js';
import { clickhouseUp } from '../testutil.js';
import { readAgentActivity } from './agent-activity.js';

const up = await clickhouseUp();
describe.skipIf(!up)('agent activity', () => {
  const db = `ww_test_agent_activity_${Date.now()}_${process.pid}`;
  const projectId = randomUUID();
  const workerId = randomUUID();
  const verifierId = randomUUID();
  const doneTaskId = randomUUID();
  const openTaskId = randomUUID();
  let ch: ClickHouseClient;

  beforeAll(async () => {
    await runMigrations({ database: db });
    ch = createCh({ database: db });
    const at = '2026-08-18T09:00:00.000Z';
    const base = {
      project_id: projectId, plan_id: randomUUID(), issuer_agent_id: randomUUID(),
      worker_agent_id: workerId, verifier_agent_id: verifierId,
      created_at: at, updated_at: at,
    };
    await ch.insert({
      table: 'tasks',
      values: [
        { ...base, task_id: doneTaskId, title: 'biten', status: 'done', version: 1 },
        { ...base, task_id: openTaskId, title: 'süren', status: 'working', version: 1 },
      ],
      format: 'JSONEachRow',
    });
    // Denetçi bu görevi İKİ KEZ reddetti; üçüncü denemede onayladı.
    await ch.insert({
      table: 'events',
      values: [1, 2].map((n) => ({
        event_id: randomUUID(), seq: String(n), project_id: projectId,
        task_id: openTaskId, agent_id: verifierId, event_type: 'status_change',
        tool_name: '', payload: JSON.stringify({ action: 'verifier_rejected', reason: 'eksik test' }),
        duration_ms: 0, created_at: at,
      })).concat([{
        event_id: randomUUID(), seq: '3', project_id: projectId,
        task_id: openTaskId, agent_id: verifierId, event_type: 'status_change',
        tool_name: '', payload: JSON.stringify({ action: 'verifier_approved' }),
        duration_ms: 0, created_at: at,
      }]),
      format: 'JSONEachRow',
    });
  });

  afterAll(async () => {
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin.close();
    await ch.close();
  });

  // ASIL KUSUR: `agents.tasks_done` / `tasks_rejected` kolonlarına ÜRETİMDE
  // hiç yazılmıyor (ölçüldü: 426 agent, hepsi 0). REST `/agents/:id` o
  // kolonları döndürüyordu, yani 8 görev bitmiş bir projede bile her agent
  // "0 tamamlandı" diyordu. Sayaçlar artık veriden TÜRETİLİR.
  it('yapilan ve reddedilen gorev sayilarini veriden turetir', async () => {
    const activity = await readAgentActivity(ch, projectId, workerId);
    expect(activity.tasksDone).toBe(1);
    expect(activity.tasksRejected).toBe(2);
  });

  // Denetçi işi YAPAN değildir: reddedilen deneme yapanın hanesine yazılır.
  it('denetcinin hanesine yapanin retlerini yazmaz', async () => {
    const activity = await readAgentActivity(ch, projectId, verifierId);
    expect(activity.tasksDone).toBe(0);
    expect(activity.tasksRejected).toBe(0);
    // Ama görev listesinde denetçi olarak görünür.
    expect(activity.tasks.map((task) => task.relation)).toContain('verifier');
  });
});
