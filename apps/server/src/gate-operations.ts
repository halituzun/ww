// `Phase1SchedulerPort` kapı ve commit işlemlerinin üretim karşılıkları.
//
// Sıra sorunu: schedulerOperations composition'a GİRDİ olarak verilir, ama
// gateRunner ve gitWorkspace composition'ın İÇİNDE kurulur. Çözüm geç
// bağlamadır — closure'lar ancak orkestrasyon sırasında çağrılır. Bunu örtük
// bırakmak yerine açık bir tutucuyla ifade ediyoruz; bağlanmadan çağrı
// sessiz `undefined` çökmesi yerine anlaşılır hata verir.
import { randomUUID } from 'node:crypto';
import type { AssignmentAttemptV1, EntityId } from '@ww/shared';

export interface GateEvidenceLike {
  passed: boolean;
  evidenceRefs: readonly string[];
}

export interface WorkspaceLike {
  initialize(): Promise<unknown>;
}

export interface GateRunnerLike {
  run(projectKey: string, workspace: WorkspaceLike, context: Readonly<{
    operationId: string;
    occurredAt: string;
  }>): Promise<GateEvidenceLike>;
}

export interface GitWorkspaceLike {
  commitAfterSuccessfulGate(
    workspace: WorkspaceLike,
    input: Record<string, unknown>,
  ): Promise<{ commitHash: string }>;
}

export interface TaskCommitDetails {
  title: string;
  summary: string;
  targetFiles: readonly string[];
  workerName: string;
  verifierName: string;
}

export interface GateOperationsInput {
  workspaceRoot: string;
  taskDetails: (taskId: EntityId) => Promise<TaskCommitDetails>;
  /** Kapı geçmeden commit'i engeller (docs/05 → çalıştırma/test kapısı). */
  requireGatePass?: boolean;
}

export interface GateBinding {
  gateRunner: GateRunnerLike;
  git: GitWorkspaceLike;
  workspace: WorkspaceLike;
}

export function createGateOperations(input: GateOperationsInput) {
  let binding: GateBinding | undefined;
  const gatePassed = new Map<string, boolean>();

  const required = (): GateBinding => {
    if (binding === undefined) {
      throw new Error('kapı işlemleri henüz bağlanmadı — composition kurulduktan sonra bind() çağrılmalı');
    }
    return binding;
  };

  return {
    bind(next: GateBinding): void {
      binding = next;
    },

    async gate({ taskId, attempt, targetFiles }: Readonly<{ taskId: EntityId; attempt: AssignmentAttemptV1; targetFiles?: readonly string[] }>) {
      const { gateRunner, workspace } = required();
      await workspace.initialize();
      const evidence = await gateRunner.run(attempt.projectId, workspace, {
        operationId: randomUUID(),
        occurredAt: new Date().toISOString(),
        ...(targetFiles === undefined ? {} : { extraInputs: targetFiles }),
      });
      gatePassed.set(`${taskId}:${attempt.assignmentAttemptId}`, evidence.passed);
      return { passed: evidence.passed, evidenceRefs: evidence.evidenceRefs };
    },

    async commit({ taskId, attempt }: Readonly<{ taskId: EntityId; attempt: AssignmentAttemptV1 }>) {
      const { git, workspace } = required();

      // Kapı geçmeden commit atmak, doğrulanmamış kodu tarihe yazmaktır.
      if (input.requireGatePass === true) {
        const passed = gatePassed.get(`${taskId}:${attempt.assignmentAttemptId}`);
        if (passed !== true) throw new Error('kapı geçilmeden commit yapılamaz');
      }

      const details = await input.taskDetails(taskId);
      await workspace.initialize();
      const result = await git.commitAfterSuccessfulGate(workspace, {
        projectKey: attempt.projectId,
        operationId: randomUUID(),
        occurredAt: new Date().toISOString(),
        taskId,
        title: details.title,
        summary: details.summary,
        workerName: details.workerName,
        verifierName: details.verifierName,
        targetFiles: details.targetFiles,
        // Erişim kapsamı olmadan yazma reddedilir; attempt bağlamı taşınmalı.
        targetAccess: [{
          projectId: attempt.projectId,
          taskId,
          taskBriefId: attempt.taskBriefId,
          assignmentAttemptId: attempt.assignmentAttemptId,
        }],
      });
      return { commitHash: result.commitHash };
    },
  };
}
