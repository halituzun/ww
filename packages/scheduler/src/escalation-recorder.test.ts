import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clickhouseUp, createCh, runMigrations, type ClickHouseClient } from '@ww/db';
import { createEscalationRecorder } from './escalation-recorder.js';

const up = await clickhouseUp();

describe.skipIf(!up)('createEscalationRecorder', () => {
  const db = `ww_test_escalation_${Date.now()}`;
  const projectId = randomUUID();
  const taskId = randomUUID();
  let ch: ClickHouseClient;

  const attempt = (over: Record<string, unknown> = {}) => ({
    assignmentAttemptId: randomUUID(),
    projectId, taskId,
    taskBriefId: randomUUID(),
    attemptNumber: 1,
    workerAgentId: randomUUID(),
    verifierAgentId: randomUUID(),
    ...over,
  }) as never;

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

  const readEscalations = async () => {
    const result = await ch.query({
      query: `SELECT event_id, task_id, agent_id, event_type,
          JSONExtractString(payload, 'reason') AS reason,
          JSONExtractString(payload, 'brakeKind') AS brake
        FROM events
        WHERE project_id = {projectId:UUID} AND event_type = 'escalation'
        ORDER BY created_at ASC`,
      query_params: { projectId }, format: 'JSONEachRow',
    });
    return result.json<Record<string, string>>();
  };

  // docs/03: her tırmandırma basamağı events'e escalation olayı yazar.
  // Bu yazıcı yoksa denetim paneli yapısal olarak boş kalır.
  it('tırmandırmayı events tablosuna escalation olarak yazar', async () => {
    const escalate = createEscalationRecorder(ch);
    await escalate({ taskId, attempt: attempt(), reason: 'verifier third persistent rejection' });

    const rows = await readEscalations();
    expect(rows).toHaveLength(1);
    expect(rows[0]!['event_type']).toBe('escalation');
    expect(rows[0]!['reason']).toContain('verifier third');
  });

  // Frenler 'brake:<tür>' gerekçesiyle çağırır; denetim paneli türü ayırt
  // edebilmeli, bu yüzden payload'a ayrı alan olarak da yazılır.
  it('fren gerekçesinden fren türünü ayrıştırıp payload’a koyar', async () => {
    const escalate = createEscalationRecorder(ch);
    await escalate({
      taskId, attempt: attempt(), reason: 'brake:cost_budget: maliyet butcesi asildi',
    });

    const rows = await readEscalations();
    const brake = rows.find((row) => row['brake'] === 'cost_budget');
    expect(brake).toBeDefined();
  });

  it('fren olmayan tırmandırmada brakeKind boş kalır', async () => {
    const escalate = createEscalationRecorder(ch);
    await escalate({ taskId, attempt: attempt(), reason: 'group lead escalation' });

    const rows = await readEscalations();
    const plain = rows.find((row) => row['reason'] === 'group lead escalation');
    expect(plain!['brake']).toBe('');
  });

  // Aynı attempt + aynı gerekçe tekrar gelirse (crash/replay) çift kayıt
  // olmamalı: olay kimliği deterministik türetilir.
  it('aynı tırmandırmayı iki kez yazmaz', async () => {
    const escalate = createEscalationRecorder(ch);
    const shared = attempt();
    await escalate({ taskId, attempt: shared, reason: 'tekrarlanan tırmandırma' });
    await escalate({ taskId, attempt: shared, reason: 'tekrarlanan tırmandırma' });

    const rows = (await readEscalations()).filter((row) => row['reason'] === 'tekrarlanan tırmandırma');
    expect(rows).toHaveLength(1);
  });

  it('worker agent kimliğini olaya iliştirir', async () => {
    const escalate = createEscalationRecorder(ch);
    const worker = randomUUID();
    await escalate({ taskId, attempt: attempt({ workerAgentId: worker }), reason: 'agent izli' });

    const rows = await readEscalations();
    const row = rows.find((entry) => entry['reason'] === 'agent izli');
    expect(row!['agent_id']).toBe(worker);
  });

  it('boş gerekçeyi reddeder', async () => {
    const escalate = createEscalationRecorder(ch);
    await expect(escalate({ taskId, attempt: attempt(), reason: '   ' }))
      .rejects.toThrow(/gerekçe/i);
  });
});
