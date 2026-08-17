// `Phase1SchedulerPort.transition` üretim karşılığı.
//
// Orkestratör dar bir çağrı yapar ({taskId, attempt, action, evidenceRefs});
// TaskTransitionService ise action'a göre farklı şekilde tam bir istek bekler.
// Bu modül ikisini eşler ve şema ihlallerini SESSİZ geçiş reddine bırakmaz.
import { randomUUID } from 'node:crypto';
import { SYSTEM_SENTINEL } from '@ww/shared';
import type {
  AssignmentAttemptV1,
  AuthenticatedPrincipalV1,
  EntityId,
  TaskTransitionRequestV1,
} from '@ww/shared';
import type { TaskStateV1 } from './ports.js';

export interface TransitionApplyPort {
  apply(
    principal: AuthenticatedPrincipalV1,
    request: TaskTransitionRequestV1,
  ): Promise<TaskStateV1>;
}

export interface TransitionOperationInput {
  port: TransitionApplyPort;
  /** Geçişleri yapan sistem bileşeninin adı (denetimde görünür). */
  principalName: string;
}

export interface TransitionCall {
  taskId: EntityId;
  attempt: AssignmentAttemptV1;
  action: string;
  evidenceRefs?: readonly string[];
  resultSummary?: string;
}

const COMMIT_HASH = /^[a-f0-9]{7,64}$/;

export function createTransitionOperation(input: TransitionOperationInput) {
  return async ({ taskId, attempt, action, evidenceRefs, resultSummary }: TransitionCall) => {
    const requestedAt = new Date().toISOString();
    // Şema 'system' kimliği için principalId = SYSTEM_SENTINEL ve bir
    // serviceName ister. Servis ADINI principalId'ye yazmak HER geçişi
    // ZodError ile düşürüyordu; `as never` bunu derleyiciden gizlemişti.
    const principal: AuthenticatedPrincipalV1 = {
      principalType: 'system',
      principalId: SYSTEM_SENTINEL,
      serviceName: input.principalName,
      authenticatedAt: requestedAt,
    } as AuthenticatedPrincipalV1;

    const identity = {
      protocolVersion: 1 as const,
      transitionRequestId: randomUUID(),
      projectId: attempt.projectId,
      taskId,
      taskBriefId: attempt.taskBriefId,
      assignmentAttemptId: attempt.assignmentAttemptId,
      causationId: randomUUID(),
      requestedAt,
    };
    const refs = evidenceRefs ?? [];

    let request: Record<string, unknown>;
    switch (action) {
      case 'start_work':
      case 'gate_passed':
        request = { ...identity, action };
        break;

      case 'report_result':
        request = {
          ...identity,
          action,
          // Şema boş özet kabul etmez; boş gelirse geçiş sessizce reddedilirdi.
          resultSummary: (resultSummary ?? '').trim() === ''
            ? 'worker raporu (özet verilmedi)'
            : resultSummary,
          evidenceRefs: refs,
        };
        break;

      case 'verifier_approved':
        request = { ...identity, action, verdictMessageId: randomUUID() };
        break;

      // Ret ve kapı başarısızlığı görevi working'e döndürür; bu geçişler
      // desteklenmediği için yeniden deneme hiç çalışmıyordu.
      case 'verifier_rejected':
        request = {
          ...identity,
          action,
          verdictMessageId: randomUUID(),
          reason: resultSummary?.trim() !== undefined && resultSummary.trim() !== ''
            ? resultSummary.trim()
            : 'verifier işi reddetti',
        };
        break;

      case 'commit_completed': {
        const commitHash = refs.find((ref) => COMMIT_HASH.test(ref));
        if (commitHash === undefined) {
          throw new Error(`commit_completed için geçerli commit hash bulunamadı: ${JSON.stringify(refs)}`);
        }
        request = { ...identity, action, commitHash, artifactIds: [] };
        break;
      }

      case 'gate_failed':
        request = {
          ...identity,
          action,
          reason: resultSummary?.trim() !== undefined && resultSummary.trim() !== ''
            ? resultSummary.trim()
            : 'kapı adımı geçilemedi',
          evidenceRefs: refs,
        };
        break;

      case 'fail':
        // Çağıranın sebebi ezilmemeli: "neden düştü" sorusunun tek cevabı odur.
        request = {
          ...identity,
          action,
          reason: resultSummary?.trim() !== undefined && resultSummary.trim() !== ''
            ? resultSummary.trim()
            : 'orkestratör görevi başarısız kapattı',
        };
        break;

      default:
        throw new Error(`desteklenmeyen transition action: ${action}`);
    }

    return input.port.apply(principal, request as unknown as TaskTransitionRequestV1);
  };
}
