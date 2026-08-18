import type {
  AgentRole,
  AssignmentAttemptV1,
  EntityId,
  JsonValue,
  StructuredVerdictV1,
  TaskBriefV1,
  TaskStatus,
} from '@ww/shared';

export interface ExecutorClockPort {
  now(): string;
  monotonicMs(): number;
}

export const systemExecutorClock: ExecutorClockPort = Object.freeze({
  now: () => new Date().toISOString(),
  monotonicMs: () => performance.now(),
});

/** Trusted host-only execution used by Git; gates and model commands use SandboxPort. */
export interface ExecutorHostCommandInput {
  readonly projectKey: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly deadlineAt?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ExecutorHostCommandResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
}

/** Production composition owns this privileged port; no host adapter is exported. */
export interface ExecutorHostCommandPort {
  run(input: ExecutorHostCommandInput): Promise<ExecutorHostCommandResult>;
}

export interface ExecutorContext {
  readonly workspaceRoot: string;
  readonly agentId: EntityId;
  readonly agentRole: AgentRole;
  readonly taskStatus: TaskStatus;
  readonly brief: TaskBriefV1;
  readonly attempt: AssignmentAttemptV1;
  /** Required by the durable effect ledger when a non-replay-safe call becomes uncertain. */
  readonly effectEscalation: {
    readonly sessionId: EntityId;
    readonly owningPmId: EntityId;
  };
}

export interface ExecutorAccessInput {
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly taskBriefId: EntityId;
  readonly assignmentAttemptId: EntityId;
  readonly agentId: EntityId;
  readonly taskStatus: TaskStatus;
  readonly leaseOwner: string;
  readonly leaseFence: number;
  readonly relativePath?: string;
  readonly requireFileLock: boolean;
}

/**
 * Scheduler composition implements this port with its current-attempt task fence and
 * file-lock owner checks. The executor calls it again immediately before a rename.
 */
export interface ExecutorAccessPort {
  assertAuthorized(input: ExecutorAccessInput): Promise<void>;
}

export interface AskQuestionToolInput {
  /** Exact model tool-call id; downstream messaging uses it as its idempotency key. */
  readonly callId: EntityId;
  readonly idempotencyKey: string;
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly taskBriefId: EntityId;
  readonly assignmentAttemptId: EntityId;
  readonly agentId: EntityId;
  readonly to: 'pm';
  readonly content: string;
}

export interface ReportResultToolInput {
  readonly callId: EntityId;
  readonly idempotencyKey: string;
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly taskBriefId: EntityId;
  readonly assignmentAttemptId: EntityId;
  readonly agentId: EntityId;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
}

export interface SubmitVerdictToolInput {
  readonly callId: EntityId;
  readonly idempotencyKey: string;
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly taskBriefId: EntityId;
  readonly assignmentAttemptId: EntityId;
  readonly agentId: EntityId;
  readonly verdict: StructuredVerdictV1;
}

/** Communication owns envelopes and scheduler transition requests; executor owns neither. */
/**
 * Alt görev açma (docs/03 → delegasyon). Sınırlar (derinlik, bütçe, döngü)
 * zamanlayıcıda uygulanır; executor yalnızca isteği iletir.
 */
export interface ExecutorDelegationPort {
  createSubtask(input: Readonly<{
    parentTaskId: string;
    title: string;
    description: string;
    files: readonly string[];
    criteria: readonly string[];
    budget: number;
  }>): Promise<JsonValue>;
}

/**
 * Projenin kendi hafızasına soru (docs/05 → `memory_query`; docs/06 → Context
 * Builder'ın sorgu modu). Bağlı değilse araç AÇIK hata verir.
 */
export interface ExecutorMemoryPort {
  query(input: Readonly<{
    projectId: string;
    question: string;
    limit: number;
  }>): Promise<JsonValue>;
}

/**
 * Kalıcı proje belleği (docs/05 → `record_knowledge` / `record_artifact`;
 * docs/01 → "asla unutmama" çekirdeği). Bağlı değilse araçlar AÇIK hata verir.
 */
export interface ExecutorRecordPort {
  recordKnowledge(input: Readonly<{
    projectId: string;
    taskId: string;
    kind: string;
    title: string;
    content: string;
    tags: readonly string[];
  }>): Promise<JsonValue>;
  recordArtifact(input: Readonly<{
    projectId: string;
    taskId: string;
    agentId: string;
    type: string;
    name: string;
    path: string;
    summary: string;
  }>): Promise<JsonValue>;
}

export interface ExecutorCommunicationPort {
  askQuestion(input: AskQuestionToolInput): Promise<JsonValue>;
  reportResult(input: ReportResultToolInput): Promise<JsonValue>;
  submitVerdict(input: SubmitVerdictToolInput): Promise<JsonValue>;
}

export interface ExecutorAuditEvent {
  readonly eventId: EntityId;
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly assignmentAttemptId: EntityId;
  readonly agentId: EntityId;
  readonly eventType: 'tool_call' | 'tool_result' | 'test_run' | 'commit' | 'error';
  readonly toolCallId: EntityId;
  readonly toolName: string;
  readonly occurredAt: string;
  readonly payload: JsonValue;
}

/**
 * The server/agents composition persists this event before any best-effort
 * wakeup. append MUST reconcile an exact duplicate and reject the same eventId
 * with divergent immutable content before the executor performs a mutation.
 */
export interface ExecutorAuditPort {
  append(event: ExecutorAuditEvent): Promise<void>;
}

export interface ExecutorToolIntent {
  readonly callId: EntityId;
  readonly toolName: string;
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly taskBriefId: EntityId;
  readonly assignmentAttemptId: EntityId;
  readonly agentId: EntityId;
  readonly leaseOwner: string;
  readonly leaseFence: number;
  readonly argsHash: string;
  readonly requestHash: string;
  readonly occurredAt: string;
}

export interface ExecutorIntentAcceptance {
  readonly state: 'accepted' | 'uncertain' | 'replay' | 'completed';
  readonly resultHash?: string;
}

/** Durable exact-intent ledger; divergent callId reuse must fail before execute. */
export interface ExecutorIntentPort {
  accept(intent: ExecutorToolIntent): Promise<ExecutorIntentAcceptance>;
  complete(input: Readonly<{ intent: ExecutorToolIntent; resultHash: string }>): Promise<void>;
}

export interface ExecutorSandboxInputPolicyPort {
  /** Returns only server-owned, sealed build/dependency manifests visible to this tool call. */
  resolveTrustedInputs(input: Readonly<{
    projectId: EntityId;
    taskId: EntityId;
    taskBriefId: EntityId;
    assignmentAttemptId: EntityId;
    agentId: EntityId;
    toolName: 'run_command';
  }>): Promise<readonly string[]>;
}

export interface ExecutorEffectExecutionContext {
  /** A stable key that the external sandbox must use for reconciliation. */
  readonly externalIdempotencyKey: string;
}

export interface ExecutorEffectInput<T> {
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly assignmentAttemptId: EntityId;
  readonly causationId: EntityId;
  readonly stableEffectId: string;
  readonly effectType: 'executor.run_command.v1';
  readonly replaySafety: 'non_replay_safe';
  readonly request: JsonValue;
  readonly escalationContext: {
    readonly sessionId: EntityId;
    readonly owningPmId: EntityId;
    readonly taskBriefId: EntityId;
  };
  readonly createdAt: string;
  readonly execute: (context: ExecutorEffectExecutionContext) => Promise<T>;
  readonly serialize: (value: T) => JsonValue;
  readonly parse: (value: JsonValue) => T;
}

/**
 * This is structurally compatible with Phase 5's EffectRunner. Production
 * composition must use it so reservation, lease heartbeat, crash reconciliation,
 * and typed escalation happen before an uncertain command can be replayed.
 */
export interface ExecutorEffectPort {
  run<T>(input: ExecutorEffectInput<T>): Promise<T>;
}

export interface GateAuditInput {
  readonly projectKey: string;
  readonly operationId: EntityId;
  readonly occurredAt: string;
  readonly step: {
    readonly name: string;
    readonly index: number;
    readonly passed: boolean;
    readonly exitCode: number | null;
    readonly timedOut: boolean;
    readonly truncated: boolean;
    readonly durationMs: number;
    readonly stdoutBytes: number;
    readonly stderrBytes: number;
    readonly stdoutHash: string;
    readonly stderrHash: string;
  };
}

interface CommitAuditBase {
  readonly projectKey: string;
  readonly operationId: EntityId;
  readonly occurredAt: string;
  readonly commitHash: string;
  readonly reconciled: boolean;
  readonly requestHash: string;
  readonly targetFingerprint: string;
}

export interface TaskCommitAuditInput extends CommitAuditBase {
  readonly kind: 'task';
  readonly projectId: EntityId;
  readonly taskId: EntityId;
  readonly taskBriefId: EntityId;
  readonly assignmentAttemptId: EntityId;
  readonly agentId: EntityId;
  readonly taskStatus: TaskStatus;
  readonly leaseOwner: string;
  readonly leaseFence: number;
  readonly targets: readonly string[];
}

export interface StarterCommitAuditInput extends CommitAuditBase {
  readonly kind: 'starter';
  readonly destinationHash: string;
}

export type CommitAuditInput = TaskCommitAuditInput | StarterCommitAuditInput;

/** Gate and commit evidence is durable and mandatory, never a callback. */
export interface GateCommitAuditPort {
  appendGate(input: GateAuditInput): Promise<void>;
  appendCommit(input: CommitAuditInput): Promise<void>;
}
