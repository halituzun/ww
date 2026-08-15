import type { ModelRouter } from '@ww/providers';
import type {
  AssignmentAttemptV1,
  EntityId,
  PromptInputSnapshotV1,
  TaskBriefV1,
} from '@ww/shared';
import { canonicalSha256V1, EntityIdSchema } from '@ww/shared';
import type { AgentRuntime } from './agent-runtime.js';
import type { WorkerCommunicationPort, WorkerToolPort } from './worker-loop.js';

export interface Phase1RuntimeContextPort {
  load(input: Readonly<{ brief: TaskBriefV1; attempt: AssignmentAttemptV1 }>): Promise<Readonly<{
    snapshot: PromptInputSnapshotV1;
    workspaceRoot: string;
    workerModelRef: string;
    verifierModelRef: string;
  }>>;
}

export interface Phase1ToolPortFactory {
  forWorker(input: Readonly<{ brief: TaskBriefV1; attempt: AssignmentAttemptV1; workspaceRoot: string }>): WorkerToolPort;
  /** Verifier tools are a separate, read-only capability boundary. */
  forVerifier?(input: Readonly<{ brief: TaskBriefV1; attempt: AssignmentAttemptV1; workspaceRoot: string }>): WorkerToolPort;
}

export type Phase1RuntimeCommunicationPort = WorkerCommunicationPort;

export interface Phase1RuntimeBridgePort {
  work(input: Readonly<{ brief: TaskBriefV1; attempt: AssignmentAttemptV1 }>): Promise<Readonly<{
    kind: 'question' | 'report' | 'failure';
    summary?: string;
    question?: string;
    questionMessageId?: EntityId;
  }>>;
  verify(input: Readonly<{ brief: TaskBriefV1; attempt: AssignmentAttemptV1; summary: string }>): Promise<Readonly<{
    verdict: import('@ww/shared').StructuredVerdictV1;
    diff: string;
  }>>;
}

/** Bridges the scheduler's narrow runtime port to AgentRuntime and ToolExecutor. */
export function createPhase1RuntimeBridge(input: Readonly<{
  runtime: AgentRuntime;
  router: ModelRouter;
  context: Phase1RuntimeContextPort;
  tools: Phase1ToolPortFactory;
  communication: Phase1RuntimeCommunicationPort;
}>): Phase1RuntimeBridgePort {
  return Object.freeze({
    work: async ({ brief, attempt }: Readonly<{ brief: TaskBriefV1; attempt: AssignmentAttemptV1 }>) => {
      const sealed = await input.context.load({ brief, attempt });
      const result = await input.runtime.worker({
        brief,
        attempt,
        snapshot: sealed.snapshot,
        modelRef: sealed.workerModelRef,
        router: input.router,
        tools: input.tools.forWorker({ brief, attempt, workspaceRoot: sealed.workspaceRoot }),
        communication: input.communication,
      });
      return Object.freeze({
        kind: result.reason === 'question' ? 'question' : result.reason === 'report' ? 'report' : 'failure',
        ...(result.summary === undefined ? {} : { summary: result.summary }),
        ...(result.question === undefined ? {} : { question: result.question }),
        ...(result.questionMessageId === undefined ? {} : { questionMessageId: result.questionMessageId }),
      });
    },
    verify: async ({ brief, attempt, summary }: Readonly<{ brief: TaskBriefV1; attempt: AssignmentAttemptV1; summary: string }>) => {
      const sealed = await input.context.load({ brief, attempt });
      if (input.tools.forVerifier === undefined) throw new Error('verifier tool factory zorunludur');
      const diffTool = input.tools.forVerifier({ brief, attempt, workspaceRoot: sealed.workspaceRoot });
      const diff = await readDiff(diffTool, sealed.snapshot, brief, attempt);
      const result = await input.runtime.verifier({
        brief,
        attempt,
        snapshot: sealed.snapshot,
        modelRef: sealed.verifierModelRef,
        router: input.router,
        diff,
        summary,
      });
      return Object.freeze({ verdict: result.verdict, diff });
    },
  });
}

function verifierDiffCallId(brief: TaskBriefV1, attempt: AssignmentAttemptV1, snapshot: PromptInputSnapshotV1): EntityId {
  const hex = canonicalSha256V1({ namespace: 'phase1-verifier-diff-v1', projectId: brief.projectId, taskId: brief.taskId, taskBriefId: brief.taskBriefId, assignmentAttemptId: attempt.assignmentAttemptId, invocationId: snapshot.invocationId });
  return EntityIdSchema.parse(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`);
}

async function readDiff(tool: WorkerToolPort, snapshot: PromptInputSnapshotV1, brief: TaskBriefV1, attempt: AssignmentAttemptV1): Promise<string> {
  const value = await tool.execute({
    callId: verifierDiffCallId(brief, attempt, snapshot),
    name: 'git_diff',
    args: {},
    occurredAt: new Date().toISOString(),
  });
  return typeof value === 'object' && value !== null && 'diff' in value ? String((value as { diff: unknown }).diff) : '';
}
