import { randomUUID } from 'node:crypto';
import {
  AgentMessageEnvelopeV1Schema,
  AuthenticatedPrincipalSnapshotV1Schema,
  NIL_UUID,
  PartyRefV1Schema,
  PolicyDecisionSchema,
  SendMessageInputV1Schema,
  canonicalSha256V1,
  parseAgentMessageEnvelopeV1,
  type AgentMessageEnvelopeV1,
  type AuthenticatedPrincipalV1,
  type AuthenticatedPrincipalSnapshotV1,
  type EntityId,
  type JsonObject,
  type PartyRefV1,
  type PolicyDecision,
  type SendMessageInputV1,
} from '@ww/shared';
import {
  CommunicationWakeupPublisher,
  RepositoryConflictError,
  StoredRecordError,
  acquireFencedLease,
  appendEffectVersion,
  appendMessage,
  appendReceiptVersion,
  createReceipt,
  findMessageByIdempotencyKey,
  findAuthoritativeAnswerWinner,
  getAssignmentAttempt,
  getEvent,
  getFencedLease,
  getLatestAgent,
  getActualModelRefForInvocation,
  getLatestEffect,
  getLatestReceipt,
  getLatestTask,
  getMessage,
  getTaskBrief,
  listLatestAgents,
  listDueInboxItems,
  listLatestReceiptsByMessage,
  messageLockKey,
  releaseFencedLease,
  renewFencedLease,
  reserveEffect,
  type AgentRow,
  type ClickHouseClient,
  type FencedLease,
  type MessageReceiptRow,
  type ProtocolV1MessageRecord,
  type TaskRow,
  type WwRedis,
} from '@ww/db';
import { evaluateCommunicationPolicy } from './communication-policy.js';
import {
  CommunicationError,
  CommunicationPolicyError,
  sanitizePersistedError,
} from './errors.js';
import {
  deterministicAgentEntityId,
  systemClock,
  type ClockPort,
  type InboxItemV1,
  type PrincipalAuthentication,
} from './ports.js';
import { PrincipalResolver } from './principal-resolver.js';
import { ensureDurableEvent } from './durable-events.js';

const TERMINAL_TASK_STATUSES = new Set(['done', 'failed', 'cancelled']);
const SEND_DENIAL_CODES = new Set([
  'ROUTE_DENIED',
  'DEADLINE_EXPIRED',
  'STALE_TASK_CONTEXT',
  'ANSWER_MISMATCH',
]);

export interface CommunicationServiceOptions {
  readonly clock?: ClockPort;
  readonly answerLeaseTtlMs?: number;
}

interface AuthorizedSend {
  readonly decision: PolicyDecision;
  readonly recipients: readonly PartyRefV1[];
  readonly principalSnapshot: AuthenticatedPrincipalSnapshotV1;
  readonly denialCode?: SendDenialCode;
}

type SendDenialCode = 'ROUTE_DENIED' | 'DEADLINE_EXPIRED' | 'STALE_TASK_CONTEXT' | 'ANSWER_MISMATCH';

function principalIntent(principal: AuthenticatedPrincipalV1): JsonObject {
  if (principal.principalType === 'agent') {
    return {
      principalType: principal.principalType,
      principalId: principal.principalId,
      role: principal.role,
      agentVersion: principal.agentVersion,
      authenticatedAt: principal.authenticatedAt,
    };
  }
  if (principal.principalType === 'system') {
    return {
      principalType: principal.principalType,
      principalId: principal.principalId,
      serviceName: principal.serviceName,
      authenticatedAt: principal.authenticatedAt,
    };
  }
  return {
    principalType: principal.principalType,
    principalId: principal.principalId,
    authenticatedAt: principal.authenticatedAt,
  };
}

function inputIntent(input: SendMessageInputV1, effectiveCorrelationId: EntityId): unknown {
  return {
    projectId: input.projectId,
    sessionId: input.sessionId,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.taskBriefId === undefined ? {} : { taskBriefId: input.taskBriefId }),
    ...(input.assignmentAttemptId === undefined
      ? {}
      : { assignmentAttemptId: input.assignmentAttemptId }),
    recipient: input.recipient,
    kind: input.kind,
    payload: input.payload,
    ...(input.replyToMessageId === undefined
      ? {}
      : { replyToMessageId: input.replyToMessageId }),
    correlationId: effectiveCorrelationId,
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    idempotencyKey: input.idempotencyKey,
    ...(input.invocationId === undefined ? {} : { invocationId: input.invocationId }),
    ...(input.promptInputSnapshotId === undefined
      ? {}
      : { promptInputSnapshotId: input.promptInputSnapshotId }),
    provenance: input.provenance,
    priority: input.priority,
    createdAt: input.createdAt,
    ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
  };
}

function sendIntentHash(
  principal: AuthenticatedPrincipalV1,
  input: SendMessageInputV1,
  effectiveCorrelationId: EntityId,
): string {
  return canonicalSha256V1({
    principal: principalIntent(principal),
    input: inputIntent(input, effectiveCorrelationId),
  });
}

export function communicationEnvelopeIntentHash(envelope: AgentMessageEnvelopeV1): string {
  return sendIntentHash(envelope.authenticatedPrincipal, SendMessageInputV1Schema.parse({
    projectId: envelope.projectId,
    sessionId: envelope.sessionId,
    ...(envelope.taskId === undefined ? {} : { taskId: envelope.taskId }),
    ...(envelope.taskBriefId === undefined ? {} : { taskBriefId: envelope.taskBriefId }),
    ...(envelope.assignmentAttemptId === undefined
      ? {}
      : { assignmentAttemptId: envelope.assignmentAttemptId }),
    recipient: envelope.recipient,
    kind: envelope.kind,
    payload: envelope.payload,
    ...(envelope.replyToMessageId === undefined
      ? {}
      : { replyToMessageId: envelope.replyToMessageId }),
    correlationId: envelope.correlationId,
    ...(envelope.causationId === undefined ? {} : { causationId: envelope.causationId }),
    idempotencyKey: envelope.idempotencyKey,
    ...(envelope.invocationId === undefined ? {} : { invocationId: envelope.invocationId }),
    ...(envelope.promptInputSnapshotId === undefined
      ? {}
      : { promptInputSnapshotId: envelope.promptInputSnapshotId }),
    provenance: envelope.provenance,
    priority: envelope.priority,
    createdAt: envelope.createdAt,
    ...(envelope.deadlineAt === undefined ? {} : { deadlineAt: envelope.deadlineAt }),
  }), envelope.correlationId);
}

export function communicationPolicyEventId(messageId: EntityId): EntityId {
  return deterministicAgentEntityId('communication-policy-v1', messageId);
}

function communicationDecision(
  ruleId: PolicyDecision['ruleId'],
  allowed: boolean,
  reason: string,
  evidenceRefs: readonly string[],
): PolicyDecision {
  return Object.freeze({ ruleId, ruleVersion: 1, allowed, reason, evidenceRefs });
}

function uniqueSortedRecipients(recipients: readonly PartyRefV1[]): readonly PartyRefV1[] {
  const byIdentity = new Map<string, PartyRefV1>();
  for (const value of recipients) {
    const recipient = PartyRefV1Schema.parse(value);
    if (recipient.type === 'broadcast') {
      throw new CommunicationError(
        'RECIPIENT_SNAPSHOT_INVALID',
        'broadcast recipient snapshot icinde broadcast sentinel bulunamaz',
      );
    }
    const identity = `${recipient.type}:${recipient.id}`;
    if (byIdentity.has(identity)) {
      throw new CommunicationError(
        'RECIPIENT_SNAPSHOT_INVALID',
        `recipient snapshot tekrari: ${recipient.id}`,
      );
    }
    byIdentity.set(identity, recipient);
  }
  return Object.freeze([...byIdentity.values()].sort((left, right) => (
    left.id.localeCompare(right.id) || left.type.localeCompare(right.type)
  )));
}

function envelopeMatchesIntent(
  record: ProtocolV1MessageRecord,
  principal: AuthenticatedPrincipalV1,
  input: SendMessageInputV1,
  messageId: EntityId,
  correlationId: EntityId,
): boolean {
  const envelope = record.envelope;
  const expected = parseAgentMessageEnvelopeV1({
    protocolVersion: 1,
    messageId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.taskBriefId === undefined ? {} : { taskBriefId: input.taskBriefId }),
    ...(input.assignmentAttemptId === undefined
      ? {}
      : { assignmentAttemptId: input.assignmentAttemptId }),
    senderPrincipalId: principal.principalId,
    authenticatedPrincipal: envelope.authenticatedPrincipal,
    recipient: input.recipient,
    kind: input.kind,
    payload: input.payload,
    ...(input.replyToMessageId === undefined
      ? {}
      : { replyToMessageId: input.replyToMessageId }),
    correlationId,
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    idempotencyKey: input.idempotencyKey,
    ...(input.invocationId === undefined ? {} : { invocationId: input.invocationId }),
    ...(input.promptInputSnapshotId === undefined
      ? {}
      : { promptInputSnapshotId: input.promptInputSnapshotId }),
    provenance: input.provenance,
    priority: input.priority,
    createdAt: input.createdAt,
    ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
  });
  return canonicalSha256V1(envelope) === canonicalSha256V1(expected) &&
    canonicalSha256V1(principalIntent(envelope.authenticatedPrincipal)) ===
      canonicalSha256V1(principalIntent(principal));
}

function taskScopeIsComplete(input: SendMessageInputV1): boolean {
  const count = [input.taskId, input.taskBriefId, input.assignmentAttemptId]
    .filter((value) => value !== undefined).length;
  return count === 0 || count === 3;
}

function taskScopeRequired(input: SendMessageInputV1): boolean {
  if (input.taskId === undefined) return false;
  return ['question', 'answer', 'report', 'verdict'].includes(input.kind);
}

function taskStatusAllows(input: SendMessageInputV1, task: TaskRow): boolean {
  if (input.kind === 'question' || input.kind === 'report') return task.status === 'working';
  if (input.kind === 'verdict') return task.status === 'verifying';
  if (input.kind === 'answer') return task.status === 'waiting_user';
  if (input.kind === 'order') return task.status === 'assigned' || task.status === 'working';
  if (input.kind === 'escalation') return true;
  return !TERMINAL_TASK_STATUSES.has(task.status);
}

function requeueReceipt(
  current: MessageReceiptRow,
): Omit<MessageReceiptRow, 'receipt_version'> {
  const {
    receipt_version,
    claim_expires_at,
    next_attempt_at,
    ...base
  } = current;
  void receipt_version;
  void claim_expires_at;
  void next_attempt_at;
  return Object.freeze({
    ...base,
    state: 'enqueued',
    claim_owner: '',
    retry_count: 0,
    error: '',
  });
}

export function communicationReceiptId(messageId: EntityId, recipient: PartyRefV1): EntityId {
  return deterministicAgentEntityId('message-receipt-v1', {
    messageId,
    recipientType: recipient.type,
    recipientId: recipient.id,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recipientsFromPolicyEvent(
  payload: unknown,
  expectedMessageId: EntityId,
  inputOrIntentHash: SendMessageInputV1 | string,
  correlationId?: EntityId,
): AuthorizedSend {
  if (!isRecord(payload) || payload['contractVersion'] !== 1) {
    throw new CommunicationError('RECIPIENT_SNAPSHOT_INVALID', 'policy event payload gecersiz');
  }
  const requiredKeys = new Set([
    'contractVersion',
    'messageId',
    'intentHash',
    'principalSnapshot',
    'decision',
    'recipientSnapshot',
  ]);
  const allowedKeys = new Set([...requiredKeys, 'denialCode']);
  const payloadKeys = Reflect.ownKeys(payload);
  if (
    payloadKeys.some((key) => typeof key !== 'string' || !allowedKeys.has(key)) ||
    [...requiredKeys].some((key) => !Object.hasOwn(payload, key))
  ) {
    throw new CommunicationError(
      'RECIPIENT_SNAPSHOT_INVALID',
      'policy event payload alanlari strict sozlesmeyle eslesmiyor',
    );
  }
  const principalSnapshot = AuthenticatedPrincipalSnapshotV1Schema.safeParse(
    payload['principalSnapshot'],
  );
  if (!principalSnapshot.success) {
    throw new CommunicationError(
      'RECIPIENT_SNAPSHOT_INVALID',
      'policy event principal snapshot gecersiz',
    );
  }
  if (typeof inputOrIntentHash !== 'string' && correlationId === undefined) {
    throw new CommunicationError(
      'RECIPIENT_SNAPSHOT_INVALID',
      'policy intent dogrulamasi correlation kimligi gerektirir',
    );
  }
  const expectedIntentHash = typeof inputOrIntentHash === 'string'
    ? inputOrIntentHash
    : sendIntentHash(principalSnapshot.data, inputOrIntentHash, correlationId!);
  if (
    payload['messageId'] !== expectedMessageId ||
    payload['intentHash'] !== expectedIntentHash ||
    !isRecord(payload['decision'])
  ) {
    throw new CommunicationError(
      'IDEMPOTENCY_COLLISION',
      'policy event sealed send intent ile catisti',
    );
  }
  const parsedDecision = PolicyDecisionSchema.safeParse(payload['decision']);
  if (!parsedDecision.success) {
    throw new CommunicationError('RECIPIENT_SNAPSHOT_INVALID', 'policy decision kaydi gecersiz');
  }
  const recipients = payload['recipientSnapshot'];
  if (!Array.isArray(recipients)) {
    throw new CommunicationError('RECIPIENT_SNAPSHOT_INVALID', 'recipient snapshot kaydi yok');
  }
  const denialCode = payload['denialCode'];
  if (
    denialCode !== undefined &&
    (typeof denialCode !== 'string' || !SEND_DENIAL_CODES.has(denialCode))
  ) {
    throw new CommunicationError('RECIPIENT_SNAPSHOT_INVALID', 'policy denial code gecersiz');
  }
  return Object.freeze({
    decision: parsedDecision.data,
    recipients: uniqueSortedRecipients(recipients.map((value) => PartyRefV1Schema.parse(value))),
    principalSnapshot: principalSnapshot.data,
    ...(typeof denialCode === 'string'
      ? { denialCode: denialCode as SendDenialCode }
      : {}),
  });
}

export class CommunicationService {
  readonly #ch: ClickHouseClient;
  readonly #redis: WwRedis;
  readonly #principalResolver: PrincipalResolver;
  readonly #wakeupPublisher: CommunicationWakeupPublisher;
  readonly #clock: ClockPort;
  readonly #answerLeaseTtlMs: number;

  constructor(
    ch: ClickHouseClient,
    redis: WwRedis,
    principalResolver: PrincipalResolver,
    wakeupPublisher: CommunicationWakeupPublisher,
    options: CommunicationServiceOptions = {},
  ) {
    this.#ch = ch;
    this.#redis = redis;
    this.#principalResolver = principalResolver;
    this.#wakeupPublisher = wakeupPublisher;
    this.#clock = options.clock ?? systemClock;
    this.#answerLeaseTtlMs = options.answerLeaseTtlMs ?? 60_000;
    if (
      !Number.isSafeInteger(this.#answerLeaseTtlMs) ||
      this.#answerLeaseTtlMs <= 0 ||
      this.#answerLeaseTtlMs > 3_600_000
    ) throw new Error('answerLeaseTtlMs 1-3600000 araliginda olmalidir');
  }

  async send(
    authentication: PrincipalAuthentication,
    inputValue: SendMessageInputV1,
  ): Promise<AgentMessageEnvelopeV1> {
    const input = SendMessageInputV1Schema.parse(inputValue);
    const messageId = deterministicAgentEntityId('agent-message-v1', {
      projectId: input.projectId,
      idempotencyKey: input.idempotencyKey,
    });
    const correlationId = input.correlationId ?? deterministicAgentEntityId(
      'agent-message-correlation-v1',
      { projectId: input.projectId, sessionId: input.sessionId, idempotencyKey: input.idempotencyKey },
    );
    const existing = await findMessageByIdempotencyKey(
      this.#ch,
      input.projectId,
      input.idempotencyKey,
    );
    const authorization = await this.#getOrSealAuthorization(
      authentication,
      input,
      messageId,
      correlationId,
      existing,
    );
    const principal = authorization.principalSnapshot;
    if (existing !== null && !envelopeMatchesIntent(
      existing,
      principal,
      input,
      messageId,
      correlationId,
    )) {
      throw new CommunicationError(
        'IDEMPOTENCY_COLLISION',
        'idempotency key farkli mesaj niyetiyle yeniden kullanildi',
      );
    }
    if (!authorization.decision.allowed) {
      await this.#appendRejectedEvent(messageId, principal, input, authorization.decision);
      throw new CommunicationPolicyError(
        authorization.denialCode ?? (
          authorization.decision.ruleId === 'COMM-004' ? 'ANSWER_MISMATCH' :
          authorization.decision.ruleId === 'COMM-003' ? 'STALE_TASK_CONTEXT' :
          'ROUTE_DENIED'
        ),
        authorization.decision.ruleId,
        authorization.decision.reason,
      );
    }
    if (
      existing !== null &&
      await this.#operationIsComplete(existing, authorization.recipients, input)
    ) {
      return existing.envelope;
    }

    let answerLease: FencedLease | undefined;
    if (input.kind === 'answer') {
      const priorSelection = await getLatestEffect(
        this.#ch,
        input.replyToMessageId!,
        'question-answer-winner',
      );
      answerLease = (await acquireFencedLease(
        this.#redis,
        messageLockKey(input.replyToMessageId!),
        `answer:${messageId}`,
        this.#answerLeaseTtlMs,
        priorSelection?.lease_fence ?? '0',
      )) ?? undefined;
      if (answerLease === undefined) {
        throw new CommunicationError(
          'RECEIPT_LEASE_UNAVAILABLE',
          'pending question cevap secimi baska bir gonderici tarafindan isleniyor',
        );
      }
    }

    try {
      const intentHash = sendIntentHash(principal, input, correlationId);
      let answerSelection: Awaited<ReturnType<typeof reserveEffect>> | undefined;
      if (answerLease !== undefined) {
        await this.#assertAnswerLease(answerLease);
        try {
          answerSelection = await reserveEffect(this.#ch, {
            causation_id: input.replyToMessageId!,
            stable_effect_id: 'question-answer-winner',
            project_id: input.projectId,
            task_id: input.taskId!,
            assignment_attempt_id: input.assignmentAttemptId!,
            effect_type: 'question_answer_selection_v1',
            request: { answerMessageId: messageId, intentHash },
            replay_safety: 'replay_safe',
            lease_fence: answerLease.fence,
            created_at: input.createdAt,
          });
        } catch (error) {
          if (error instanceof RepositoryConflictError) {
            const decision = communicationDecision(
              'COMM-004',
              false,
              'pending question icin farkli bir cevap zaten secildi',
              [`reply:${input.replyToMessageId!}`],
            );
            await this.#appendRejectedEvent(messageId, principal, input, decision);
            throw new CommunicationError(
              'ANSWER_MISMATCH',
              'pending question icin farkli bir cevap zaten secildi',
              error,
            );
          }
          throw error;
        }
        if (BigInt(answerSelection.lease_fence) > BigInt(answerLease.fence)) {
          throw new CommunicationError('STALE_RECEIPT_FENCE', 'answer selection fence stale');
        }
        if (answerSelection.state === 'succeeded') {
          if (
            !isRecord(answerSelection.result) ||
            answerSelection.result['answerMessageId'] !== messageId
          ) {
            throw new CommunicationError('ANSWER_MISMATCH', 'question answer winner sonucu catisti');
          }
        } else if (answerSelection.state !== 'pending') {
          throw new CommunicationError('ANSWER_MISMATCH', 'question answer secimi terminal durumda');
        }
        await this.#assertAnswerLease(answerLease);
      }

      const envelope = existing?.envelope ?? AgentMessageEnvelopeV1Schema.parse({
        protocolVersion: 1,
        messageId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        ...(input.taskBriefId === undefined ? {} : { taskBriefId: input.taskBriefId }),
        ...(input.assignmentAttemptId === undefined
          ? {}
          : { assignmentAttemptId: input.assignmentAttemptId }),
        senderPrincipalId: principal.principalId,
        authenticatedPrincipal: authorization.principalSnapshot,
        recipient: input.recipient,
        kind: input.kind,
        payload: input.payload,
        ...(input.replyToMessageId === undefined
          ? {}
          : { replyToMessageId: input.replyToMessageId }),
        correlationId,
        ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
        idempotencyKey: input.idempotencyKey,
        ...(input.invocationId === undefined ? {} : { invocationId: input.invocationId }),
        ...(input.promptInputSnapshotId === undefined
          ? {}
          : { promptInputSnapshotId: input.promptInputSnapshotId }),
        provenance: input.provenance,
        priority: input.priority,
        createdAt: input.createdAt,
        ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
      });
      let actualModelRef: string | undefined;
      if (input.kind === 'report' || input.kind === 'verdict') {
        if (existing !== null) {
          if (existing.actualModelRef === undefined) {
            throw new CommunicationError(
              'MODEL_PROVENANCE_INVALID',
              'stored agent sonucu actual model ref tasimiyor',
            );
          }
          actualModelRef = existing.actualModelRef;
        }
        if (
          authorization.principalSnapshot.principalType !== 'agent' ||
          input.invocationId === undefined ||
          input.taskId === undefined ||
          input.taskBriefId === undefined ||
          input.assignmentAttemptId === undefined ||
          input.promptInputSnapshotId === undefined
        ) {
          throw new CommunicationError(
            'MODEL_PROVENANCE_INVALID',
            'agent sonucu authoritative invocation baglamini tasimiyor',
          );
        }
        if (existing === null) {
          try {
            const usage = await getActualModelRefForInvocation(this.#ch, input.invocationId, {
              projectId: input.projectId,
              agentId: authorization.principalSnapshot.principalId,
              taskId: input.taskId,
              taskBriefId: input.taskBriefId,
              assignmentAttemptId: input.assignmentAttemptId,
              promptInputSnapshotId: input.promptInputSnapshotId,
            });
            if (usage === null) {
              throw new CommunicationError(
                'MODEL_PROVENANCE_INVALID',
                'invocation icin basarili authoritative usage kaydi bulunamadi',
              );
            }
            actualModelRef = usage.usedRef;
          } catch (error) {
            if (error instanceof CommunicationError) throw error;
            if (
              !(error instanceof StoredRecordError) &&
              !(error instanceof RepositoryConflictError)
            ) throw error;
            throw new CommunicationError(
              'MODEL_PROVENANCE_INVALID',
              'invocation provenance scope veya model kaydi catisti',
              error,
            );
          }
        }
      }
      const stored = await appendMessage(this.#ch, {
        envelope,
        ...(actualModelRef === undefined ? {} : { actualModelRef }),
      });
      if (answerLease !== undefined) await this.#assertAnswerLease(answerLease);
      const receipts = await Promise.all(authorization.recipients.map((recipient) => createReceipt(
        this.#ch,
        {
        receipt_id: communicationReceiptId(stored.envelope.messageId, recipient),
          message_id: stored.envelope.messageId,
          project_id: stored.envelope.projectId,
          recipient_id: recipient.id,
          recipient_snapshot: recipient,
          state: 'enqueued',
          claim_owner: '',
          claim_fence: '0',
          retry_count: 0,
          error: '',
          created_at: stored.envelope.createdAt,
        },
      )));
      const folded = await listLatestReceiptsByMessage(
        this.#ch,
        stored.envelope.projectId,
        stored.envelope.messageId,
        { limit: 1_000 },
      );
      this.#assertCompleteReceiptSnapshot(stored, authorization.recipients, folded);
      await this.#repairOperationEvents(stored, authorization.recipients);
      if (answerSelection !== undefined && answerSelection.state !== 'succeeded') {
        await this.#assertAnswerLease(answerLease!);
        const completed = await appendEffectVersion(this.#ch, {
          causation_id: input.replyToMessageId!,
          stable_effect_id: 'question-answer-winner',
          expectedVersion: answerSelection.effect_version,
          state: 'succeeded',
          result: { answerMessageId: messageId },
          error: '',
          lease_fence: answerLease!.fence,
          created_at: input.createdAt,
        });
        if (
          BigInt(completed.lease_fence) > BigInt(answerLease!.fence) ||
          completed.state !== 'succeeded'
        ) {
          throw new CommunicationError('STALE_RECEIPT_FENCE', 'answer selection tamamlanamadi');
        }
      }
      const enqueued = input.kind === 'answer'
        ? await this.#readyAnswerReceipts(stored)
        : receipts.filter((receipt) => receipt.state === 'enqueued');
      if (enqueued.length > 0) {
        await this.#wakeupPublisher.publishAfterDurableWrite({
          message: {
            messageId: stored.envelope.messageId,
            projectId: stored.envelope.projectId,
            recipient: stored.envelope.recipient,
          },
          receipts: enqueued.map((receipt) => ({
            messageId: receipt.message_id,
            projectId: receipt.project_id,
            recipientId: receipt.recipient_id,
            recipient: receipt.recipient_snapshot,
            state: 'enqueued' as const,
          })),
        });
      }
      return stored.envelope;
    } finally {
      if (answerLease !== undefined) {
        await releaseFencedLease(this.#redis, answerLease).catch(() => false);
      }
    }
  }

  async #getOrSealAuthorization(
    authentication: PrincipalAuthentication,
    input: SendMessageInputV1,
    messageId: EntityId,
    correlationId: EntityId,
    existing: ProtocolV1MessageRecord | null,
  ): Promise<AuthorizedSend> {
    const policyEventId = communicationPolicyEventId(messageId);
    const readSealed = async (): Promise<AuthorizedSend | null> => {
      const event = await getEvent(this.#ch, policyEventId);
      if (event === null) return null;
      if (
        event.event_type !== 'policy_decision' ||
        event.tool_name !== 'communication_policy' ||
        event.project_id !== input.projectId
      ) {
        throw new CommunicationError(
          'RECIPIENT_SNAPSHOT_INVALID',
          'stored policy event metadata gecersiz',
        );
      }
      const authorization = recipientsFromPolicyEvent(
        event.payload,
        messageId,
        input,
        correlationId,
      );
      this.#principalResolver.assertMatchesSealed(
        authentication,
        input.projectId,
        authorization.principalSnapshot,
      );
      return authorization;
    };

    const preflight = await readSealed();
    if (preflight !== null) return preflight;
    const deadline = Date.now() + this.#answerLeaseTtlMs;
    const lockKey = messageLockKey(messageId);
    while (Date.now() < deadline) {
      const lease = await acquireFencedLease(
        this.#redis,
        lockKey,
        `policy:${randomUUID()}`,
        this.#answerLeaseTtlMs,
        '0',
      );
      if (lease === null) {
        const sealed = await readSealed();
        if (sealed !== null) return sealed;
        await wait(10);
        continue;
      }
      try {
        await this.#assertAnswerLease(lease);
        const sealed = await readSealed();
        if (sealed !== null) return sealed;
        const currentExisting = existing ?? await findMessageByIdempotencyKey(
          this.#ch,
          input.projectId,
          input.idempotencyKey,
        );
        if (currentExisting !== null) {
          throw new CommunicationError(
            'RECIPIENT_SNAPSHOT_INVALID',
            'kalici mesaj deterministic policy eventi olmadan oynatilamaz',
          );
        }
        const principal = await this.#principalResolver.resolve(authentication, input.projectId);
        const authorization = await this.#authorize(principal, input);
        await this.#assertAnswerLease(lease);
        await this.#assertAgentPrincipalStillCurrent(principal, input.projectId);
        await this.#assertAnswerLease(lease);
        await this.#appendPolicyEvent(
          policyEventId,
          messageId,
          principal,
          input,
          sendIntentHash(principal, input, correlationId),
          authorization,
        );
        const persisted = await readSealed();
        if (persisted === null) {
          throw new CommunicationError(
            'RECIPIENT_SNAPSHOT_INVALID',
            'policy seal acknowledged write sonrasinda okunamadi',
          );
        }
        return persisted;
      } finally {
        await releaseFencedLease(this.#redis, lease).catch(() => false);
      }
    }
    throw new CommunicationError(
      'RECEIPT_LEASE_UNAVAILABLE',
      'policy principal snapshot lease zamaninda alinamadi',
    );
  }

  async #assertAgentPrincipalStillCurrent(
    principal: AuthenticatedPrincipalV1,
    projectId: EntityId,
  ): Promise<void> {
    if (principal.principalType !== 'agent') return;
    const current = await getLatestAgent(this.#ch, projectId, principal.principalId);
    if (current === null) {
      throw new CommunicationError('PRINCIPAL_NOT_FOUND', 'policy seal oncesi agent bulunamadi');
    }
    if (current.status === 'stopped') {
      throw new CommunicationError('PRINCIPAL_STOPPED', 'policy seal oncesi agent durduruldu');
    }
    const currentVersion = Number(current.version);
    if (
      !Number.isSafeInteger(currentVersion) ||
      current.agent_id !== principal.principalId ||
      current.role !== principal.role ||
      currentVersion !== principal.agentVersion
    ) {
      throw new CommunicationError(
        'INVALID_AUTHENTICATION',
        'policy seal oncesi agent principal snapshot stale oldu',
      );
    }
  }

  async #repairOperationEvents(
    message: ProtocolV1MessageRecord,
    recipients: readonly PartyRefV1[],
  ): Promise<void> {
    await this.#appendStoredEvent(
      message,
      message.envelope.authenticatedPrincipal,
      recipients,
    );
    await Promise.all(recipients.map((recipient) => (
      this.#appendEnqueuedReceiptEvent(message, recipient)
    )));
  }

  async #operationIsComplete(
    existing: ProtocolV1MessageRecord,
    recipients: readonly PartyRefV1[],
    input: SendMessageInputV1,
  ): Promise<boolean> {
    const receipts = await listLatestReceiptsByMessage(
      this.#ch,
      existing.envelope.projectId,
      existing.envelope.messageId,
      { limit: 1_000 },
    );
    if (receipts.length < recipients.length) return false;
    this.#assertCompleteReceiptSnapshot(existing, recipients, receipts);
    await this.#repairOperationEvents(existing, recipients);
    if (input.kind !== 'answer') return true;
    const winner = await findAuthoritativeAnswerWinner(
      this.#ch,
      input.projectId,
      input.replyToMessageId!,
    );
    if (winner === null) return false;
    if (winner.envelope.messageId !== existing.envelope.messageId) {
      throw new CommunicationError(
        'ANSWER_MISMATCH',
        'stored answer authoritative winner ile eslesmiyor',
      );
    }
    return true;
  }

  async #readyAnswerReceipts(
    message: ProtocolV1MessageRecord,
  ): Promise<readonly MessageReceiptRow[]> {
    const pendingDetail = sanitizePersistedError(new CommunicationError(
      'ANSWER_WINNER_PENDING',
      'authoritative answer winner pending',
    )).serialized;
    const latest = await listLatestReceiptsByMessage(
      this.#ch,
      message.envelope.projectId,
      message.envelope.messageId,
      { limit: 1_000 },
    );
    const ready: MessageReceiptRow[] = [];
    for (const receipt of latest) {
      if (receipt.state === 'enqueued') {
        ready.push(receipt);
        continue;
      }
      if (receipt.state !== 'claimed' || receipt.error !== pendingDetail) continue;
      try {
        ready.push(await appendReceiptVersion(this.#ch, {
          expectedVersion: receipt.receipt_version,
          next: requeueReceipt(receipt),
        }));
      } catch (error) {
        if (!(error instanceof RepositoryConflictError)) throw error;
        const observed = await getLatestReceipt(
          this.#ch,
          receipt.project_id,
          receipt.receipt_id,
        );
        if (observed?.state === 'enqueued') ready.push(observed);
      }
    }
    return Object.freeze(ready);
  }

  async pollInbox(recipientValue: PartyRefV1, limit = 100): Promise<InboxItemV1[]> {
    const recipient = PartyRefV1Schema.parse(recipientValue);
    if (recipient.type === 'broadcast') {
      throw new CommunicationError('ROUTE_DENIED', 'broadcast bir inbox recipient olamaz');
    }
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new CommunicationError('ROUTE_DENIED', 'inbox limit 1-1000 araliginda olmalidir');
    }
    return listDueInboxItems(this.#ch, {
      now: this.#clock.now(),
      recipientId: recipient.id,
      limit,
    });
  }

  async #authorize(
    principal: AuthenticatedPrincipalV1,
    input: SendMessageInputV1,
  ): Promise<AuthorizedSend> {
    const now = this.#clock.now();
    if (input.deadlineAt !== undefined && Date.parse(input.deadlineAt) <= Date.parse(now)) {
      return Object.freeze({
        decision: communicationDecision('COMM-003', false, 'mesaj son tarihi gecmis', [
          `deadline:${input.deadlineAt}`,
        ]),
        recipients: [],
        principalSnapshot: principal,
        denialCode: 'DEADLINE_EXPIRED',
      });
    }
    if (!taskScopeIsComplete(input) || (taskScopeRequired(input) && input.taskId === undefined)) {
      return Object.freeze({
        decision: communicationDecision(
          'COMM-003',
          false,
          'mesaj task, brief ve assignment attempt kimliklerini birlikte tasimalidir',
          [`kind:${input.kind}`],
        ),
        recipients: [],
        principalSnapshot: principal,
        denialCode: 'STALE_TASK_CONTEXT',
      });
    }

    const historicalEscalation = principal.principalType === 'system' && input.kind === 'escalation';
    if (
      historicalEscalation &&
      (
        input.provenance.class !== 'system_generated' ||
        input.causationId === undefined ||
        input.provenance.sourceId !== input.causationId
      )
    ) {
      return Object.freeze({
        decision: communicationDecision(
          'COMM-003',
          false,
          'code-owned escalation system provenance ve causation kimligini tasimalidir',
          [`kind:${input.kind}`],
        ),
        recipients: [],
        principalSnapshot: principal,
        denialCode: 'STALE_TASK_CONTEXT',
      });
    }

    let task: TaskRow | undefined;
    if (input.taskId !== undefined) {
      const current = await getLatestTask(this.#ch, input.projectId, input.taskId);
      if (
        current === null ||
        (!historicalEscalation && current.task_brief_id !== input.taskBriefId) ||
        (!historicalEscalation && current.assignment_attempt_id !== input.assignmentAttemptId) ||
        !taskStatusAllows(input, current)
      ) {
        return Object.freeze({
          decision: communicationDecision(
            'COMM-003',
            false,
            'mesaj task/brief/attempt veya current task durumu ile eslesmiyor',
            [`task:${input.taskId}`],
          ),
          recipients: [],
          principalSnapshot: principal,
          denialCode: 'STALE_TASK_CONTEXT',
        });
      }
      const brief = await getTaskBrief(this.#ch, input.taskBriefId!);
      const attempt = await getAssignmentAttempt(this.#ch, input.assignmentAttemptId!);
      if (
        brief === null ||
        brief.projectId !== input.projectId ||
        brief.taskId !== input.taskId ||
        attempt === null ||
        attempt.projectId !== input.projectId ||
        attempt.taskId !== input.taskId ||
        attempt.taskBriefId !== input.taskBriefId ||
        (!historicalEscalation && attempt.workerAgentId !== current.worker_agent_id) ||
        (!historicalEscalation && attempt.verifierAgentId !== current.verifier_agent_id)
      ) {
        return Object.freeze({
          decision: communicationDecision(
            'COMM-003',
            false,
            'task brief bulunamadi, uyusmuyor veya son tarihi gecmis',
            [`brief:${input.taskBriefId}`],
          ),
          recipients: [],
          principalSnapshot: principal,
          denialCode: 'STALE_TASK_CONTEXT',
        });
      }
      if (
        input.kind !== 'escalation' &&
        brief.deadlineAt !== undefined &&
        Date.parse(brief.deadlineAt) <= Date.parse(now)
      ) {
        return Object.freeze({
          decision: communicationDecision(
            'COMM-003',
            false,
            'task brief son tarihi gecmis',
            [`brief:${input.taskBriefId}`, `deadline:${brief.deadlineAt}`],
          ),
          recipients: [],
          principalSnapshot: principal,
          denialCode: 'DEADLINE_EXPIRED',
        });
      }
      task = current;
    }

    let recipientAgent: AgentRow | undefined;
    if (input.recipient.type === 'agent') {
      recipientAgent = (await getLatestAgent(
        this.#ch,
        input.projectId,
        input.recipient.id,
      )) ?? undefined;
    }
    const senderAgent = principal.principalType === 'agent'
      ? (await getLatestAgent(this.#ch, input.projectId, principal.principalId)) ?? undefined
      : undefined;

    let answerTargetValid: boolean | undefined;
    if (input.kind === 'answer') {
      answerTargetValid = await this.#answerMatchesExactlyOnePendingQuestion(input);
    }

    let broadcastRecipients: readonly AgentRow[] | undefined;
    if (input.recipient.type === 'broadcast' && principal.principalType === 'agent') {
      const agents = await listLatestAgents(this.#ch, input.projectId, { limit: 1_000 });
      broadcastRecipients = agents.filter((agent) => (
        agent.role === 'worker' &&
        agent.status !== 'stopped' &&
        (task === undefined
          ? agent.parent_agent_id === principal.principalId
          : agent.agent_id === task.worker_agent_id)
      ));
    }
    const decision = evaluateCommunicationPolicy({
      principal,
      input,
      ...(senderAgent === undefined ? {} : { senderAgent }),
      ...(recipientAgent === undefined ? {} : { recipientAgent }),
      ...(task === undefined ? {} : { task }),
      ...(broadcastRecipients === undefined ? {} : { broadcastRecipients }),
      ...(answerTargetValid === undefined ? {} : { answerTargetValid }),
    });
    const recipients = input.recipient.type === 'broadcast'
      ? (broadcastRecipients ?? []).map((agent) => ({
        type: 'agent' as const,
        id: agent.agent_id,
      }))
      : [input.recipient];
    return Object.freeze({
      decision,
      recipients: uniqueSortedRecipients(recipients),
      principalSnapshot: principal,
      ...(!decision.allowed
        ? { denialCode: decision.ruleId === 'COMM-004' ? 'ANSWER_MISMATCH' as const : 'ROUTE_DENIED' as const }
        : {}),
    });
  }

  async #answerMatchesExactlyOnePendingQuestion(input: SendMessageInputV1): Promise<boolean> {
    if (input.replyToMessageId === undefined || input.recipient.type !== 'agent') return false;
    const question = await getMessage(this.#ch, input.projectId, input.replyToMessageId);
    if (question === null || question.protocolVersion !== 1) return false;
    const envelope = question.envelope;
    if (
      envelope.kind !== 'question' ||
      envelope.authenticatedPrincipal.principalType !== 'agent' ||
      envelope.senderPrincipalId !== input.recipient.id ||
      envelope.sessionId !== input.sessionId ||
      envelope.taskId !== input.taskId ||
      envelope.taskBriefId !== input.taskBriefId ||
      envelope.assignmentAttemptId !== input.assignmentAttemptId
    ) return false;
    const policyEvent = await getEvent(
      this.#ch,
      communicationPolicyEventId(envelope.messageId),
    );
    if (
      policyEvent === null ||
      policyEvent.event_type !== 'policy_decision' ||
      policyEvent.tool_name !== 'communication_policy' ||
      policyEvent.project_id !== envelope.projectId ||
      !isRecord(policyEvent.payload) ||
      policyEvent.payload['messageId'] !== envelope.messageId
    ) return false;
    let questionAuthorization: AuthorizedSend;
    try {
      questionAuthorization = recipientsFromPolicyEvent(
        policyEvent.payload,
        envelope.messageId,
        communicationEnvelopeIntentHash(envelope),
      );
    } catch {
      return false;
    }
    if (
      !questionAuthorization.decision.allowed ||
      questionAuthorization.recipients.filter((recipient) => (
        recipient.type === envelope.recipient.type && recipient.id === envelope.recipient.id
      )).length !== 1
    ) return false;
    const winner = await findAuthoritativeAnswerWinner(
      this.#ch,
      input.projectId,
      input.replyToMessageId,
    );
    return winner === null;
  }

  async #appendPolicyEvent(
    eventId: EntityId,
    messageId: EntityId,
    principal: AuthenticatedPrincipalV1,
    input: SendMessageInputV1,
    intentHash: string,
    authorization: AuthorizedSend,
  ): Promise<void> {
    await ensureDurableEvent(this.#ch, {
      event_id: eventId,
      seq: String(Date.parse(input.createdAt)),
      project_id: input.projectId,
      task_id: input.taskId ?? NIL_UUID,
      agent_id: principal.principalType === 'agent' ? principal.principalId : NIL_UUID,
      event_type: 'policy_decision',
      tool_name: 'communication_policy',
      payload: {
        contractVersion: 1,
        messageId,
        intentHash,
        principalSnapshot: principal,
        decision: authorization.decision,
        recipientSnapshot: authorization.recipients,
        ...(authorization.denialCode === undefined ? {} : { denialCode: authorization.denialCode }),
      },
      duration_ms: 0,
      created_at: input.createdAt,
    });
  }

  async #appendRejectedEvent(
    messageId: EntityId,
    principal: AuthenticatedPrincipalV1,
    input: SendMessageInputV1,
    decision: PolicyDecision,
  ): Promise<void> {
    await ensureDurableEvent(this.#ch, {
      event_id: deterministicAgentEntityId('message-rejected-v1', messageId),
      seq: String(Date.parse(input.createdAt)),
      project_id: input.projectId,
      task_id: input.taskId ?? NIL_UUID,
      agent_id: principal.principalType === 'agent' ? principal.principalId : NIL_UUID,
      event_type: 'message_rejected',
      tool_name: 'communication_service',
      payload: { contractVersion: 1, messageId, decision },
      duration_ms: 0,
      created_at: input.createdAt,
    });
  }

  async #appendStoredEvent(
    message: ProtocolV1MessageRecord,
    principal: AuthenticatedPrincipalV1,
    recipients: readonly PartyRefV1[],
  ): Promise<void> {
    const envelope = message.envelope;
    await ensureDurableEvent(this.#ch, {
      event_id: deterministicAgentEntityId('message-stored-v1', envelope.messageId),
      seq: String(Date.parse(envelope.createdAt)),
      project_id: envelope.projectId,
      task_id: envelope.taskId ?? NIL_UUID,
      agent_id: principal.principalType === 'agent' ? principal.principalId : NIL_UUID,
      event_type: 'message_stored',
      tool_name: 'communication_service',
      payload: {
        contractVersion: 1,
        messageId: envelope.messageId,
        envelopeHash: message.envelopeHash,
        recipientSnapshot: recipients,
      },
      duration_ms: 0,
      created_at: envelope.createdAt,
    });
  }

  async #appendEnqueuedReceiptEvent(
    message: ProtocolV1MessageRecord,
    recipient: PartyRefV1,
  ): Promise<void> {
    const receiptId = communicationReceiptId(message.envelope.messageId, recipient);
    await ensureDurableEvent(this.#ch, {
      event_id: deterministicAgentEntityId('receipt-changed-v1', {
        receiptId,
        receiptVersion: '1',
        claimFence: '0',
      }),
      seq: String(Date.parse(message.envelope.createdAt)),
      project_id: message.envelope.projectId,
      task_id: message.envelope.taskId ?? NIL_UUID,
      agent_id: NIL_UUID,
      event_type: 'receipt_changed',
      tool_name: 'communication_service',
      payload: {
        contractVersion: 1,
        receiptId,
        messageId: message.envelope.messageId,
        state: 'enqueued',
        retryCount: 0,
        claimFence: '0',
      },
      duration_ms: 0,
      created_at: message.envelope.createdAt,
    });
  }

  async #assertAnswerLease(lease: FencedLease): Promise<void> {
    const current = await getFencedLease(this.#redis, lease.lockKey);
    if (
      current === null ||
      current.owner !== lease.owner ||
      current.fence !== lease.fence
    ) {
      throw new CommunicationError('STALE_RECEIPT_FENCE', 'question answer lease stale');
    }
    if (!await renewFencedLease(this.#redis, lease, this.#answerLeaseTtlMs)) {
      throw new CommunicationError('STALE_RECEIPT_FENCE', 'question answer lease yenilenemedi');
    }
  }

  #assertCompleteReceiptSnapshot(
    message: ProtocolV1MessageRecord,
    recipients: readonly PartyRefV1[],
    receipts: readonly MessageReceiptRow[],
  ): void {
    const expected = new Map(recipients.map((recipient) => [
      communicationReceiptId(message.envelope.messageId, recipient),
      recipient,
    ]));
    if (receipts.length !== expected.size) {
      throw new CommunicationError(
        'RECIPIENT_SNAPSHOT_INVALID',
        'kalici receipt sayisi recipient snapshot ile eslesmiyor',
      );
    }
    for (const receipt of receipts) {
      const recipient = expected.get(receipt.receipt_id);
      if (
        recipient === undefined ||
        receipt.message_id !== message.envelope.messageId ||
        receipt.project_id !== message.envelope.projectId ||
        receipt.recipient_id !== recipient.id ||
        canonicalSha256V1(receipt.recipient_snapshot) !== canonicalSha256V1(recipient)
      ) {
        throw new CommunicationError(
          'RECIPIENT_SNAPSHOT_INVALID',
          'receipt recipient snapshot ile eslesmiyor',
        );
      }
    }
  }
}
