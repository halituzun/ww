import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { AUDIT_FINDING_STATUSES } from '@ww/shared';
import { createAuditFinding, listLatestAuditFindingsByStatus } from '@ww/db';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { buildAuditFinding, parseFindingInput } from './audit-finding.service.js';
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

  /**
   * Denetim bulgusu kaydeder (docs/03 standart denetçileri).
   *
   * Bulguyu YARATAN hiçbir üretim yolu yoktu: ekran kalıcı olarak boştu ve
   * boş bir denetim ekranı "ihlal yok" der — oysa denetim hiç çalışmamıştır.
   */
  @Post('findings')
  async record(
    @Req() request: LocalSessionRequest,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    parseLocalSession(request);
    const id = ProjectId.parse(projectId);
    const now = new Date().toISOString();
    const finding = buildAuditFinding(id, parseFindingInput(body), now);
    try {
      return await createAuditFinding(this.#database.ch, { finding: finding as never, updated_at: now });
    } catch (reason) {
      // Şema ihlali kullanıcı hatasıdır (ör. düzeltme bekleyen bulguda görev yok).
      const message = reason instanceof Error ? reason.message : String(reason);
      throw new BadRequestException(message);
    }
  }

  /**
   * Tırmandırmalar İKİ kaynaktan okunur.
   *
   * docs/03 her basamağın hem `messages`'a hem `events`'e yazılmasını söyler.
   * Gerçekte `escalation-delivery` yalnız mesaj üretiyor; frenler ise
   * scheduler.escalate üzerinden event bekliyor. Tek kaynağa bakmak paneli
   * yapısal olarak boş bırakırdı. İkisi birleştirilip kimliğe göre tekilleştirilir.
   */
  async #readEscalations(projectId: string): Promise<EscalationEntry[]> {
    const [eventRows, messageRows] = await Promise.all([
      this.#database.ch.query({
        query: `SELECT event_id AS id, task_id, agent_id, created_at,
            JSONExtractString(payload, 'reason') AS reason,
            JSONExtractString(payload, 'brakeKind') AS brake_kind
          FROM events
          WHERE project_id = {projectId:UUID} AND event_type = 'escalation'
          ORDER BY created_at DESC LIMIT 100`,
        query_params: { projectId }, format: 'JSONEachRow',
      }).then((r) => r.json<Record<string, unknown>>()),

      this.#database.ch.query({
        query: `SELECT message_id AS id, task_id, from_agent_id AS agent_id, created_at,
            content AS reason
          FROM messages
          WHERE project_id = {projectId:UUID} AND kind = 'escalation'
          ORDER BY created_at DESC LIMIT 100`,
        query_params: { projectId }, format: 'JSONEachRow',
      }).then((r) => r.json<Record<string, unknown>>()),
    ]);

    const byId = new Map<string, EscalationEntry>();
    for (const row of [...eventRows, ...messageRows]) {
      const reason = String(row['reason'] ?? '');
      // brakeKind artık payload'da açık alan; metin ayrıştırma yalnız eski
      // kayıtlar ve mesaj kaynağı için geriye dönük yedek olarak kalır.
      const explicit = String(row['brake_kind'] ?? '');
      const brake = explicit === '' ? /^brake:([a-z_]+)/.exec(reason)?.[1] ?? '' : explicit;
      const id = String(row['id'] ?? '');
      if (id === '' || byId.has(id)) continue;
      byId.set(id, {
        eventId: id,
        taskId: String(row['task_id'] ?? ''),
        agentId: String(row['agent_id'] ?? ''),
        reason,
        brakeKind: brake,
        createdAt: String(row['created_at'] ?? ''),
      });
    }

    return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
