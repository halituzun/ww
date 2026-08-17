// Commit sonrası standart denetimi ve düzeltme görevi (docs/11 Faz 4).
//
// NEDEN VAR: `StandardsAuditor` bulguyu yalnızca KAYDEDEN bir sınıftı, hiçbir
// üretim yolu onu çağırmıyordu ve bulguyu ÜRETEN denetçi hiç yoktu. Faz 4'ün
// kabul senaryosundaki "denetçiler en az bir bulgu üretip DÜZELTTİRİR" adımı
// bu yüzden hiç koşamadı.
//
// Akış: görev commit'lendi → değişen dosyalar docs/09'a karşı denetlenir →
// ihlal varsa bulgu açılır → bulgu bir DÜZELTME GÖREVİNE bağlanır. Bulguyu
// açıp görev açmamak, denetimi "rapor edip unutan" bir süse çevirirdi.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  createAuditFinding,
  createTask,
  getLatestProject,
  listLatestAgents,
  listLatestPlansByStatus,
} from '@ww/db';
import { NIL_UUID, type EntityId } from '@ww/shared';
import { auditMvvmView, type StandardsViolation } from './standards-audit.js';
import { resolveTaskPlanId } from './task-plan-id.js';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';

export interface AuditedFile {
  readonly filePath: string;
  readonly content: string;
}

export interface StandardsAuditOutcome {
  readonly findings: readonly {
    readonly findingId: EntityId;
    readonly ruleId: string;
    readonly filePath: string;
    readonly correctiveTaskId: EntityId;
  }[];
}

/** Düzeltme görevinin tanımı: worker'ın ne yapacağı burada AÇIKÇA yazılır. */
export function correctiveTaskDescription(violation: StandardsViolation): string {
  return [
    violation.summary,
    '',
    `Kanıt: ${violation.evidenceRefs.join(', ')}`,
    '',
    'Bu dosyayı docs/09 MVVM standardına uygun hale getir: veri erişimini ve',
    'durumu ViewModel katmanına taşı, View yalnızca çizsin. Davranışı değiştirme.',
  ].join('\n');
}

@Injectable()
export class StandardsAuditApplicationService {
  readonly #logger = new Logger(StandardsAuditApplicationService.name);
  readonly #database: ServerDatabase;

  constructor(@Inject(SERVER_DATABASE) database: ServerDatabase) {
    this.#database = database;
  }

  /**
   * Verilen dosyaları denetler; her ihlal için bulgu + düzeltme görevi açar.
   * Bulgu `correction_pending` yazılır: şema bu statüde düzeltme görevi ister,
   * yani "bulgu var ama kimse düzeltmiyor" durumu kayıt seviyesinde imkânsızdır.
   */
  async auditFiles(
    projectId: string,
    files: readonly AuditedFile[],
    sourceTaskId?: EntityId,
  ): Promise<StandardsAuditOutcome> {
    const project = await getLatestProject(this.#database.ch, projectId);
    if (project === null) throw new Error('proje bulunamadi');
    const agents = await listLatestAgents(this.#database.ch, project.project_id as EntityId);
    const issuer = agents.find((agent) => agent.role === 'pm' && agent.status !== 'stopped')
      ?? agents.find((agent) => agent.status !== 'stopped');
    if (issuer === undefined) throw new Error('proje icin aktif agent bulunamadi');

    // Plansız görev ATANAMAZ ve sessizce hiç çalışmaz (bkz. task-plan-id.ts).
    // Düzeltme görevini plansız açmak, denetimi yine "rapor edip unutan" bir
    // süse çevirirdi — bulgu açılır, görev görünür, ama kimse düzeltmez.
    const planId = resolveTaskPlanId(undefined, {
      approved: await listLatestPlansByStatus(this.#database.ch, project.project_id, 'approved'),
      proposed: await listLatestPlansByStatus(this.#database.ch, project.project_id, 'proposed'),
    });

    const violations = files.flatMap((file) => auditMvvmView(file.filePath, file.content));
    const now = new Date().toISOString();
    const findings: {
      findingId: EntityId; ruleId: string; filePath: string; correctiveTaskId: EntityId;
    }[] = [];

    for (const violation of violations) {
      const correctiveTaskId = randomUUID() as EntityId;
      await createTask(this.#database.ch, {
        task_id: correctiveTaskId,
        project_id: project.project_id,
        plan_id: planId,
        parent_task_id: sourceTaskId ?? NIL_UUID,
        title: `Standart düzeltmesi: ${violation.filePath}`,
        description: correctiveTaskDescription(violation),
        acceptance_criteria: [`${violation.filePath} docs/09 MVVM standardına uyar`],
        status: 'queued',
        // Düzeltme görevi standart ihlalidir: normal öncelikte kuyruğa girer.
        priority: 0,
        issuer_agent_id: issuer.agent_id,
        worker_agent_id: NIL_UUID,
        verifier_agent_id: NIL_UUID,
        group: 'coding',
        depends_on: [],
        target_files: [violation.filePath],
        attempt: 0,
        max_attempts: 3,
        // Düzeltme görevi kaynak görevin ALTINDA açılır; derinlik sınırı
        // delegasyon zincirinin sonsuza gitmesini engeller.
        delegation_depth: sourceTaskId === undefined ? 0 : 1,
        token_budget: 0,
        tokens_spent: 0,
        commit_hash: '',
        result_summary: '',
        reject_reason: '',
        task_brief_id: NIL_UUID,
        assignment_attempt_id: NIL_UUID,
        created_at: now,
        updated_at: now,
      } as never);

      const findingId = randomUUID() as EntityId;
      await createAuditFinding(this.#database.ch, {
        finding: {
          findingId,
          projectId: project.project_id as EntityId,
          ...(sourceTaskId === undefined ? {} : { taskId: sourceTaskId }),
          profile: 'verifier',
          rule: { ruleId: violation.ruleId, ruleVersion: 1 },
          severity: violation.severity,
          summary: violation.summary,
          evidenceRefs: [...violation.evidenceRefs],
          // Bulgu doğrudan düzeltmeye bağlanır; şema bu statüde görev ister.
          status: 'correction_pending',
          correctiveTaskId,
          createdAt: now,
        } as never,
        updated_at: now,
      });
      findings.push({
        findingId, ruleId: violation.ruleId, filePath: violation.filePath, correctiveTaskId,
      });
    }

    if (findings.length > 0) {
      this.#logger.log(`standart denetimi ${findings.length} bulgu açtı ve düzeltme görevi verdi`);
    }
    return Object.freeze({ findings: Object.freeze(findings) });
  }
}
