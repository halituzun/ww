import { Controller, Get, Inject, Param } from '@nestjs/common';
import { z } from 'zod';
import { AUDIT_FINDING_STATUSES } from '@ww/shared';
import { listLatestAuditFindingsByStatus } from '@ww/db';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';

const ProjectId = z.string().uuid();

export interface EscalationEntry {
  eventId: string;
  taskId: string;
  agentId: string;
  /** brake:<kind> ise fren tetiklenmesi; değilse normal tırmandırma. */
  reason: string;
  brakeKind: string;
  createdAt: string;
}

// docs/08 → Denetim Ekranı: denetçi bulguları, tırmandırma geçmişi ve fren olayları.
@Controller('projects/:projectId/audit')
export class AuditController {
  readonly #database: ServerDatabase;

  constructor(@Inject(SERVER_DATABASE) database: ServerDatabase) {
    this.#database = database;
  }

  @Get()
  async report(@Param('projectId') projectId: string) {
    const id = ProjectId.parse(projectId);

    const [byStatus, escalations] = await Promise.all([
      Promise.all(AUDIT_FINDING_STATUSES.map(async (status) => ({
        status,
        records: await listLatestAuditFindingsByStatus(this.#database.ch, id, status),
      }))),
      this.#readEscalations(id),
    ]);

    const findings = byStatus.flatMap(({ records }) =>
      records.map((record) => ({ ...record.finding, updatedAt: record.updated_at })));

    return {
      projectId: id,
      findings,
      counts: Object.fromEntries(byStatus.map(({ status, records }) => [status, records.length])),
      escalations,
      // Fren kaynaklı tırmandırmalar ayrıca sayılır: güvenlik sınırının kaç kez
      // devreye girdiği, denetçi bulgularından ayrı bir sinyaldir.
      brakeTrips: escalations.filter((entry) => entry.brakeKind !== '').length,
    };
  }

  async #readEscalations(projectId: string): Promise<EscalationEntry[]> {
    const result = await this.#database.ch.query({
      // events append-only'dir; tırmandırma geçmişi burada kalıcıdır.
      query: `SELECT event_id, task_id, agent_id, created_at,
          JSONExtractString(payload, 'reason') AS reason
        FROM events
        WHERE project_id = {projectId:UUID} AND event_type = 'escalation'
        ORDER BY created_at DESC
        LIMIT 100`,
      query_params: { projectId },
      format: 'JSONEachRow',
    });
    const rows = await result.json<Record<string, unknown>>();
    return rows.map((row) => {
      const reason = String(row['reason'] ?? '');
      const brake = /^brake:([a-z_]+)/.exec(reason);
      return {
        eventId: String(row['event_id'] ?? ''),
        taskId: String(row['task_id'] ?? ''),
        agentId: String(row['agent_id'] ?? ''),
        reason,
        brakeKind: brake?.[1] ?? '',
        createdAt: String(row['created_at'] ?? ''),
      };
    });
  }
}
