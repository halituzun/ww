import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clickhouseUp, createCh, runMigrations, type ClickHouseClient } from '@ww/db';
import { AuditController } from './audit.controller.js';

const up = await clickhouseUp();

describe.skipIf(!up)('AuditController', () => {
  const db = `ww_test_audit_${Date.now()}`;
  const projectId = randomUUID();
  const taskId = randomUUID();
  let ch: ClickHouseClient;
  let controller: AuditController;

  beforeAll(async () => {
    await runMigrations({ database: db });
    ch = createCh({ database: db });
    controller = new AuditController({ ch } as never);

    const at = (n: number) =>
      new Date(Date.now() - n * 1000).toISOString().replace('Z', '');

    await ch.insert({
      table: 'events',
      values: [
        {
          event_id: randomUUID(), seq: '1', project_id: projectId, task_id: taskId,
          agent_id: randomUUID(), event_type: 'escalation', tool_name: '',
          payload: JSON.stringify({ reason: 'brake:cost_budget: maliyet butcesi asildi' }),
          duration_ms: 0, created_at: at(1),
        },
        {
          event_id: randomUUID(), seq: '2', project_id: projectId, task_id: taskId,
          agent_id: randomUUID(), event_type: 'escalation', tool_name: '',
          payload: JSON.stringify({ reason: 'verifier third persistent rejection' }),
          duration_ms: 0, created_at: at(2),
        },
        // Farklı proje: rapora sızmamalı.
        {
          event_id: randomUUID(), seq: '3', project_id: randomUUID(), task_id: randomUUID(),
          agent_id: randomUUID(), event_type: 'escalation', tool_name: '',
          payload: JSON.stringify({ reason: 'brake:wall_clock: sizmamali' }),
          duration_ms: 0, created_at: at(3),
        },
        // Tırmandırma olmayan olay sayılmamalı.
        {
          event_id: randomUUID(), seq: '4', project_id: projectId, task_id: taskId,
          agent_id: randomUUID(), event_type: 'status_change', tool_name: '',
          payload: JSON.stringify({ action: 'start_work' }),
          duration_ms: 0, created_at: at(4),
        },
      ],
      format: 'JSONEachRow',
    });
  });

  afterAll(async () => {
    const admin = createCh({ database: 'default' });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin.close();
    await ch.close();
  });

  it('yalnız istenen projenin tırmandırmalarını döner', async () => {
    const report = await controller.report(projectId);
    expect(report.escalations).toHaveLength(2);
    expect(report.escalations.every((entry) => entry.reason !== 'brake:wall_clock: sizmamali')).toBe(true);
  });

  // Fren tetiklenmeleri denetçi bulgularından ayrı bir sinyaldir: güvenlik
  // sınırının kaç kez devreye girdiğini gösterir.
  it('fren kaynaklı tırmandırmayı türüyle ayırt eder', async () => {
    const report = await controller.report(projectId);
    const brake = report.escalations.find((entry) => entry.brakeKind !== '');
    expect(brake?.brakeKind).toBe('cost_budget');
    expect(report.brakeTrips).toBe(1);
  });

  it('fren olmayan tırmandırmayı fren saymaz', async () => {
    const report = await controller.report(projectId);
    const plain = report.escalations.find((entry) => entry.reason.includes('verifier'));
    expect(plain?.brakeKind).toBe('');
  });

  it('bulgu durumlarının tamamını sayar', async () => {
    const report = await controller.report(projectId);
    expect(Object.keys(report.counts).sort())
      .toEqual(['correction_pending', 'dismissed', 'open', 'resolved']);
  });

  it('geçersiz proje kimliğini reddeder', async () => {
    await expect(controller.report('bozuk-kimlik')).rejects.toThrow();
  });
});
