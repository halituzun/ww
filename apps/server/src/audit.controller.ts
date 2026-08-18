import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Patch, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { AUDIT_FINDING_STATUSES } from '@ww/shared';
import { appendAuditFindingVersion, createAuditFinding, getLatestAuditFinding, listLatestAuditFindingsByStatus } from '@ww/db';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { buildAuditFinding, parseFindingInput } from './audit-finding.service.js';
import { applyResolution, parseResolutionInput } from './audit-resolution.service.js';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';
import { auditTaskRecords, type RecordViolation } from './record-audit.js';

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

    const [byStatus, escalations, recordFindings] = await Promise.all([
      Promise.all(AUDIT_FINDING_STATUSES.map(async (status) => ({
        status,
        records: await listLatestAuditFindingsByStatus(this.#database.ch, id, status),
      }))),
      this.#readEscalations(id),
      this.#auditRecords(id),
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
      // docs/09 `db_write_audit` (b): ww KAYITLARININ tamlığı. Bu denetim
      // yazılıydı ama uygulaması yoktu; oysa yakaladığı şey deponun tekrar
      // eden sessiz hatasıdır — iş "bitti" görünür, kayıt yoktur.
      recordFindings,
    };
  }

  /**
   * `db_write_audit` (b) meta-denetimi: done görevlerin commit'i, artifact
   * kaydı ve dokundukları dosyaların fihristi var mı?
   *
   * Denetim OKUMADIR ve rapor uçunu düşürmemelidir: sorgu patlarsa denetim
   * ekranının tamamı boş dönerdi — asıl bulguları da kaybederdik.
   */
  async #auditRecords(projectId: string): Promise<readonly RecordViolation[]> {
    try {
      const rows = await this.#database.ch.query({
        query: `SELECT t.task_id AS taskId, t.title AS title, t.status AS status,
              t.commit_hash AS commitHash, t.target_files AS targetFiles,
              t.plan_id AS planId, a.artifactCount AS artifactCount
            FROM (SELECT task_id, argMax(title, version) AS title,
                    argMax(status, version) AS status,
                    argMax(commit_hash, version) AS commit_hash,
                    argMax(target_files, version) AS target_files,
                    argMax(plan_id, version) AS plan_id
                  FROM tasks WHERE project_id = {projectId:UUID} GROUP BY task_id) t
            LEFT JOIN (SELECT task_id, count() AS artifactCount FROM artifacts
                       WHERE project_id = {projectId:UUID} GROUP BY task_id) a
              ON a.task_id = t.task_id
            -- done DISINDA queued da denetlenir: plansiz kuyruk gorevi
            -- (REC-004) tam olarak burada gorunur hale gelir.
            WHERE t.status IN ('done', 'queued') LIMIT 500`,
        query_params: { projectId }, format: 'JSONEachRow',
      }).then((r) => r.json<Record<string, unknown>>());

      const indexed = await this.#database.ch.query({
        query: `SELECT DISTINCT file_path FROM file_index
          WHERE project_id = {projectId:UUID} LIMIT 5000`,
        query_params: { projectId }, format: 'JSONEachRow',
      }).then((r) => r.json<Record<string, unknown>>());
      const indexedFiles = indexed.map((row) => String(row['file_path'] ?? ''));

      return auditTaskRecords(rows.map((row) => ({
        taskId: String(row['taskId'] ?? ''),
        title: String(row['title'] ?? ''),
        status: String(row['status'] ?? ''),
        commitHash: String(row['commitHash'] ?? ''),
        artifactCount: Number(row['artifactCount'] ?? 0),
        targetFiles: Array.isArray(row['targetFiles']) ? row['targetFiles'].map(String) : [],
        indexedFiles,
        planId: String(row['planId'] ?? ''),
      })));
    } catch (reason) {
      console.warn(`[ww] kayıt denetimi koşulamadı: ${String(reason)}`);
      return [];
    }
  }

  /**
   * Denetim bulgusu kaydeder (docs/03 standart denetçileri).
   *
   * Bulguyu YARATAN hiçbir üretim yolu yoktu: ekran kalıcı olarak boştu ve
   * boş bir denetim ekranı "ihlal yok" der — oysa denetim hiç çalışmamıştır.
   */
  /**
   * Bulguyu kapatır/yeniden açar. Açılıp hiç kapanmayan bulgu listesi zamanla
   * anlamını yitirir: "açık" sayısı gerçek borç değil birikmiş gürültü olur.
   */
  @Patch('findings/:findingId')
  async resolve(
    @Req() request: LocalSessionRequest,
    @Param('projectId') projectId: string,
    @Param('findingId') findingId: string,
    @Body() body: unknown,
  ) {
    parseLocalSession(request);
    const id = ProjectId.parse(projectId);
    const current = await getLatestAuditFinding(this.#database.ch, id as never, findingId as never);
    if (current === null) throw new NotFoundException(`bulgu bulunamadı: ${findingId}`);
    const next = applyResolution(
      current.finding as unknown as Record<string, unknown>,
      parseResolutionInput(body),
    );
    try {
      return await appendAuditFindingVersion(this.#database.ch, {
        finding: next as never,
        // Beklenen sürüm: eşzamanlı bir güncelleme sessizce ezilmemeli.
        expectedVersion: current.finding_version,
        updated_at: new Date().toISOString(),
      });
    } catch (reason) {
      throw new BadRequestException(reason instanceof Error ? reason.message : String(reason));
    }
  }

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
