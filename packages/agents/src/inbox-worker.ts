import {
  NIL_UUID,
  AuthenticatedPrincipalSnapshotV1Schema,
  PartyRefV1Schema,
  PolicyDecisionSchema,
  TaskTransitionRequestV1Schema,
  canonicalSha256V1,
  parseAgentMessageEnvelopeV1,
  type AgentMessageEnvelopeV1,
  type PartyRefV1,
  type TaskTransitionRequestV1,
} from '@ww/shared';
import {
  acquireFencedLease,
  appendReceiptVersion,
  dueMessageReceiptCandidateId,
  findAuthoritativeAnswerWinner,
  getAssignmentAttempt,
  getEvent,
  getFencedLease,
  getActualModelRefForInvocation,
  getLatestEffect,
  getLatestAgent,
  getLatestReceipt,
  getMessage,
  getLatestTask,
  getTaskBrief,
  listDueMessageReceiptCandidates,
  listLatestReceiptsByMessage,
  listTerminalReceiptEventCandidates,
  quarantineDueMessageReceiptCandidate,
  receiptLockKey,
  releaseFencedLease,
  renewFencedLease,
  RepositoryConflictError,
  StoredRecordError,
  type ClickHouseClient,
  type DueInboxItemRecord,
  type FencedLease,
  type InvalidDueMessageReceiptCandidate,
  type ListDueMessageReceiptsOptions,
  type MessageReceiptRow,
  type WwRedis,
} from '@ww/db';
import { EffectRunner } from './effect-runner.js';
import { ensureDurableEvent } from './durable-events.js';
import {
  communicationEnvelopeIntentHash,
  communicationPolicyEventId,
  communicationReceiptId,
} from './communication-service.js';
import {
  CommunicationError,
  sanitizePersistedError,
} from './errors.js';
import {
  deterministicAgentEntityId,
  systemClock,
  type ClockPort,
  type DrainResult,
  type EffectEscalationContextV1,
  type MessageDispatchPort,
  type ProcessResult,
  type ReceiptEscalationPort,
  type TaskTransitionPort,
} from './ports.js';

const DEFAULT_CLAIM_TTL_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 1_000;
const DEFAULT_DRAIN_LIMIT = 100;
const PERMANENT_INBOX_ERROR_CODES = new Set([
  'STALE_TASK_CONTEXT',
  'ROUTE_DENIED',
  'ANSWER_MISMATCH',
  'RECIPIENT_SNAPSHOT_INVALID',
  'DEADLINE_EXPIRED',
  'EFFECT_FAILED',
  'MODEL_PROVENANCE_INVALID',
]);

export interface InboxWorkerOptions {
  readonly clock?: ClockPort;
  readonly claimTtlMs?: number;
  readonly maxRetries?: number;
  readonly backoffBaseMs?: number;
  readonly drainLimit?: number;
  readonly dispatchPort?: MessageDispatchPort;
  readonly receiptEscalationPort?: ReceiptEscalationPort;
}

function positiveInteger(value: number, context: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${context} 1-${maximum} araliginda olmalidir`);
  }
  return value;
}

function nonempty(value: string, context: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context} bos olamaz`);
  }
  return value;
}

type ReceiptPatch = Omit<
  Partial<Omit<MessageReceiptRow, 'receipt_version'>>,
  'claim_expires_at' | 'next_attempt_at'
> & Readonly<{
  claim_expires_at?: string | null;
  next_attempt_at?: string | null;
}>;

function receiptNext(
  current: MessageReceiptRow,
  patch: ReceiptPatch,
): Omit<MessageReceiptRow, 'receipt_version'> {
  const {
    receipt_version,
    claim_expires_at: currentClaimExpiresAt,
    next_attempt_at: currentNextAttemptAt,
    ...base
  } = current;
  void receipt_version;
  const {
    claim_expires_at: patchClaimExpiresAt,
    next_attempt_at: patchNextAttemptAt,
    ...rest
  } = patch;
  const claimExpiresAt = Object.hasOwn(patch, 'claim_expires_at')
    ? patchClaimExpiresAt
    : currentClaimExpiresAt;
  const nextAttemptAt = Object.hasOwn(patch, 'next_attempt_at')
    ? patchNextAttemptAt
    : currentNextAttemptAt;
  return Object.freeze({
    ...base,
    ...rest,
    ...(claimExpiresAt == null ? {} : { claim_expires_at: claimExpiresAt }),
    ...(nextAttemptAt == null ? {} : { next_attempt_at: nextAttemptAt }),
  });
}

function safeError(error: unknown): string {
  return sanitizePersistedError(error).serialized;
}

function sameRecipient(left: PartyRefV1, right: PartyRefV1): boolean {
  return left.type === right.type && left.id === right.id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class ReceiptLeaseGuard {
  readonly lease: FencedLease;
  readonly #redis: WwRedis;
  readonly #ttlMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #renewal: Promise<boolean> | undefined;
  #lost = false;

  constructor(redis: WwRedis, lease: FencedLease, ttlMs: number) {
    this.#redis = redis;
    this.lease = lease;
    this.#ttlMs = ttlMs;
    this.#timer = setInterval(() => {
      if (this.#renewal !== undefined || this.#lost) return;
      this.#renewal = renewFencedLease(this.#redis, this.lease, this.#ttlMs)
        .then((held) => {
          if (!held) this.#lost = true;
          return held;
        })
        .catch(() => {
          this.#lost = true;
          return false;
        })
        .finally(() => { this.#renewal = undefined; });
    }, Math.max(10, Math.floor(ttlMs / 3)));
    this.#timer.unref();
  }

  async assertHeld(): Promise<void> {
    if (this.#renewal !== undefined) await this.#renewal;
    if (this.#lost) {
      throw new CommunicationError('STALE_RECEIPT_FENCE', 'receipt claim lease kaybedildi');
    }
    const held = await getFencedLease(this.#redis, this.lease.lockKey);
    if (
      held === null ||
      held.owner !== this.lease.owner ||
      held.fence !== this.lease.fence ||
      !await renewFencedLease(this.#redis, this.lease, this.#ttlMs)
    ) {
      this.#lost = true;
      throw new CommunicationError('STALE_RECEIPT_FENCE', 'receipt claim lease stale');
    }
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    if (this.#renewal !== undefined) await this.#renewal.catch(() => false);
    await releaseFencedLease(this.#redis, this.lease).catch(() => false);
  }
}

export class InboxWorker {
  readonly #ch: ClickHouseClient;
  readonly #redis: WwRedis;
  readonly #transitionPort: TaskTransitionPort;
  readonly #effectRunner: EffectRunner;
  readonly #clock: ClockPort;
  readonly #claimTtlMs: number;
  readonly #maxRetries: number;
  readonly #backoffBaseMs: number;
  readonly #drainLimit: number;
  readonly #dispatchPort: MessageDispatchPort | undefined;
  readonly #receiptEscalationPort: ReceiptEscalationPort | undefined;

  constructor(
    ch: ClickHouseClient,
    redis: WwRedis,
    transitionPort: TaskTransitionPort,
    effectRunner: EffectRunner,
    options: InboxWorkerOptions = {},
  ) {
    this.#ch = ch;
    this.#redis = redis;
    this.#transitionPort = transitionPort;
    this.#effectRunner = effectRunner;
    this.#clock = options.clock ?? systemClock;
    this.#claimTtlMs = positiveInteger(
      options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS,
      'claimTtlMs',
      3_600_000,
    );
    this.#maxRetries = positiveInteger(
      options.maxRetries ?? DEFAULT_MAX_RETRIES,
      'maxRetries',
      100,
    );
    this.#backoffBaseMs = positiveInteger(
      options.backoffBaseMs ?? DEFAULT_BACKOFF_MS,
      'backoffBaseMs',
      3_600_000,
    );
    this.#drainLimit = positiveInteger(
      options.drainLimit ?? DEFAULT_DRAIN_LIMIT,
      'drainLimit',
      1_000,
    );
    this.#dispatchPort = options.dispatchPort;
    this.#receiptEscalationPort = options.receiptEscalationPort;
  }

  async processNext(recipientValue: PartyRefV1, consumerIdValue: string): Promise<ProcessResult> {
    const recipient = PartyRefV1Schema.parse(recipientValue);
    if (recipient.type === 'broadcast') {
      throw new CommunicationError('ROUTE_DENIED', 'broadcast inbox recipient olamaz');
    }
    const consumerId = nonempty(consumerIdValue, 'consumerId');
    const scan = await this.#listDueItems({
      now: this.#clock.now(),
      recipientId: recipient.id,
      limit: 1,
    });
    const item = scan.items[0];
    if (item === undefined) {
      await this.#repairTerminalReceiptEvents(1);
      return scan.quarantined[0] ?? Object.freeze({ state: 'idle', recipient });
    }
    return this.#processItem(item, recipient, consumerId);
  }

  async drainOnce(consumerIdValue: string, signal?: AbortSignal): Promise<DrainResult> {
    const consumerId = nonempty(consumerIdValue, 'consumerId');
    signal?.throwIfAborted();
    const scan = await this.#listDueItems({
      now: this.#clock.now(),
      limit: this.#drainLimit,
    }, signal);
    signal?.throwIfAborted();
    const results: ProcessResult[] = [...scan.quarantined];
    for (const item of scan.items) {
      signal?.throwIfAborted();
      try {
        results.push(await this.#processItem(
          item,
          item.receipt.recipient_snapshot,
          consumerId,
        ));
      } catch (error) {
        results.push(Object.freeze({
          state: 'error',
          recipient: item.receipt.recipient_snapshot,
          messageId: item.message.envelope.messageId,
          receiptId: item.receipt.receipt_id,
          error: safeError(error),
        }));
      }
      signal?.throwIfAborted();
    }
    await this.#repairTerminalReceiptEvents(this.#drainLimit, signal);
    signal?.throwIfAborted();
    return Object.freeze({
      consumerId,
      scanned: scan.items.length + scan.quarantined.length,
      processed: results.filter((result) => result.state === 'processed').length,
      retryScheduled: results.filter((result) => result.state === 'retry_scheduled').length,
      failed: results.filter((result) => result.state === 'failed').length,
      busy: results.filter((result) => result.state === 'busy').length,
      stale: results.filter((result) => result.state === 'stale').length,
      errors: results.filter((result) => result.state === 'error').length,
      quarantined: results.filter((result) => result.state === 'quarantined').length,
      results: Object.freeze(results),
    });
  }

  async #listDueItems(
    options: ListDueMessageReceiptsOptions,
    signal?: AbortSignal,
  ): Promise<Readonly<{
    items: readonly DueInboxItemRecord[];
    quarantined: readonly Extract<ProcessResult, { state: 'quarantined' }>[];
  }>> {
    const candidates = await listDueMessageReceiptCandidates(this.#ch, options);
    const items: DueInboxItemRecord[] = [];
    const quarantined: Extract<ProcessResult, { state: 'quarantined' }>[] = [];
    for (const candidate of candidates.invalid) {
      signal?.throwIfAborted();
      quarantined.push(await this.#quarantineInvalidCandidate(candidate));
    }
    for (const receipt of candidates.valid) {
      signal?.throwIfAborted();
      try {
        const message = await getMessage(this.#ch, receipt.project_id, receipt.message_id);
        if (
          message === null ||
          message.protocolVersion !== 1 ||
          message.envelope.messageId !== receipt.message_id ||
          message.envelope.projectId !== receipt.project_id ||
          receipt.recipient_snapshot.type === 'broadcast' ||
          (
            message.envelope.recipient.type !== 'broadcast' &&
            !sameRecipient(message.envelope.recipient, receipt.recipient_snapshot)
          )
        ) {
          throw new CommunicationError(
            'MALFORMED_DUE_ITEM',
            'due receipt message projection ile eslesmiyor',
          );
        }
        items.push(Object.freeze({ message, receipt }));
      } catch (error) {
        if (
          !(error instanceof StoredRecordError) &&
          !(error instanceof RepositoryConflictError) &&
          !(error instanceof CommunicationError && error.code === 'MALFORMED_DUE_ITEM')
        ) {
          throw error;
        }
        const identity = Object.freeze({
          code: 'stored_record_invalid' as const,
          projectId: receipt.project_id,
          receiptId: receipt.receipt_id,
          messageId: receipt.message_id,
          receiptVersion: receipt.receipt_version,
          claimFence: receipt.claim_fence,
          observationHash: canonicalSha256V1({
            scope: 'message-projection-invalid-v1',
            projectId: receipt.project_id,
            receiptId: receipt.receipt_id,
            messageId: receipt.message_id,
            receiptVersion: receipt.receipt_version,
            claimFence: receipt.claim_fence,
          }),
        });
        quarantined.push(await this.#quarantineInvalidCandidate({
          ...identity,
          candidateId: dueMessageReceiptCandidateId(identity),
          summary: 'latest receipt candidate failed stored-record validation',
        }, 'message_projection_invalid'));
      }
    }
    return Object.freeze({ items: Object.freeze(items), quarantined: Object.freeze(quarantined) });
  }

  async #repairTerminalReceiptEvents(limit: number, signal?: AbortSignal): Promise<void> {
    const receipts = await listTerminalReceiptEventCandidates(this.#ch, { limit });
    for (const receipt of receipts) {
      signal?.throwIfAborted();
      const message = await getMessage(this.#ch, receipt.project_id, receipt.message_id);
      if (
        message === null ||
        message.protocolVersion !== 1 ||
        message.envelope.messageId !== receipt.message_id ||
        message.envelope.projectId !== receipt.project_id ||
        (receipt.state !== 'processed' && receipt.state !== 'failed')
      ) {
        throw new CommunicationError(
          'MALFORMED_DUE_ITEM',
          'terminal receipt event repair message projection ile eslesmiyor',
        );
      }
      await this.#appendReceiptEvent(receipt, message.envelope, receipt.state);
      signal?.throwIfAborted();
    }
  }

  async #quarantineInvalidCandidate(
    candidate: InvalidDueMessageReceiptCandidate,
    code: 'message_projection_invalid' | InvalidDueMessageReceiptCandidate['code'] = candidate.code,
  ): Promise<Extract<ProcessResult, { state: 'quarantined' }>> {
    const error = `MALFORMED_DUE_ITEM: ${candidate.summary}`;
    const quarantine = await quarantineDueMessageReceiptCandidate(
      this.#ch,
      candidate,
      this.#clock.now(),
    );
    await ensureDurableEvent(this.#ch, {
      event_id: deterministicAgentEntityId('malformed-due-item-v1', candidate.candidateId),
      seq: String(Date.parse(quarantine.quarantinedAt)),
      project_id: candidate.projectId,
      task_id: NIL_UUID,
      agent_id: NIL_UUID,
      event_type: 'error',
      tool_name: 'inbox_worker_observer',
      payload: {
        contractVersion: 1,
        candidateId: candidate.candidateId,
        code,
        summary: candidate.summary,
        receiptId: candidate.receiptId,
        messageId: candidate.messageId,
      },
      duration_ms: 0,
      created_at: quarantine.quarantinedAt,
    }).catch(() => undefined);
    return Object.freeze({
      state: 'quarantined',
      candidateId: candidate.candidateId,
      code,
      projectId: candidate.projectId,
      receiptId: candidate.receiptId,
      messageId: candidate.messageId,
      error,
    });
  }

  async #processItem(
    item: DueInboxItemRecord,
    recipient: PartyRefV1,
    consumerId: string,
  ): Promise<ProcessResult> {
    const initial = await getLatestReceipt(
      this.#ch,
      item.receipt.project_id,
      item.receipt.receipt_id,
    );
    if (
      initial === null ||
      initial.receipt_version !== item.receipt.receipt_version ||
      initial.claim_fence !== item.receipt.claim_fence
    ) {
      return Object.freeze({
        state: 'stale',
        recipient,
        messageId: item.message.envelope.messageId,
        receiptId: item.receipt.receipt_id,
      });
    }
    if (!sameRecipient(initial.recipient_snapshot, recipient)) {
      throw new CommunicationError('RECIPIENT_SNAPSHOT_INVALID', 'receipt inbox recipient ile eslesmiyor');
    }
    const lease = await acquireFencedLease(
      this.#redis,
      receiptLockKey(initial.receipt_id),
      consumerId,
      this.#claimTtlMs,
      initial.claim_fence,
    );
    if (lease === null) {
      return Object.freeze({ state: 'busy', recipient, receiptId: initial.receipt_id });
    }
    const guard = new ReceiptLeaseGuard(this.#redis, lease, this.#claimTtlMs);
    try {
      await guard.assertHeld();
      let claimed: MessageReceiptRow;
      try {
        claimed = await appendReceiptVersion(this.#ch, {
          expectedVersion: initial.receipt_version,
          next: receiptNext(initial, {
            state: 'claimed',
            claim_owner: consumerId,
            claim_fence: lease.fence,
            claim_expires_at: new Date(
              Date.parse(this.#clock.now()) + this.#claimTtlMs,
            ).toISOString(),
            next_attempt_at: null,
            error: '',
          }),
        });
      } catch (error) {
        if (error instanceof RepositoryConflictError) {
          return Object.freeze({
            state: 'stale',
            recipient,
            messageId: item.message.envelope.messageId,
            receiptId: initial.receipt_id,
          });
        }
        throw error;
      }
      if (BigInt(claimed.claim_fence) > BigInt(lease.fence)) {
        return Object.freeze({
          state: 'stale',
          recipient,
          messageId: item.message.envelope.messageId,
          receiptId: initial.receipt_id,
        });
      }
      await this.#appendReceiptEvent(claimed, item.message.envelope, 'claimed');
      await guard.assertHeld();
      const foldedClaim = await getLatestReceipt(this.#ch, claimed.project_id, claimed.receipt_id);
      if (
        foldedClaim === null ||
        foldedClaim.state !== 'claimed' ||
        foldedClaim.claim_owner !== consumerId ||
        foldedClaim.claim_fence !== lease.fence
      ) {
        throw new CommunicationError('STALE_RECEIPT_FENCE', 'kalici receipt claim uzlastirilamadi');
      }

      try {
        const envelope = parseAgentMessageEnvelopeV1(item.message.envelope);
        if (!sameRecipient(foldedClaim.recipient_snapshot, recipient)) {
          throw new CommunicationError(
            'RECIPIENT_SNAPSHOT_INVALID',
            'stored envelope recipient receipt snapshot ile eslesmiyor',
          );
        }
        await this.#assertStoredAuthorization(item.message, foldedClaim);
        await this.#assertAuthoritativeAnswerWinner(envelope);
        const stableEffectId = this.#stableEffectId(envelope, foldedClaim);
        const existingEffect = await getLatestEffect(
          this.#ch,
          envelope.messageId,
          stableEffectId,
        );
        if (existingEffect === null) {
          if (
            envelope.deadlineAt !== undefined &&
            Date.parse(envelope.deadlineAt) <= Date.parse(this.#clock.now())
          ) {
            throw new CommunicationError(
              'DEADLINE_EXPIRED',
              'inbox mesaji islenmeden once sona erdi',
            );
          }
          await this.#assertCurrentContext(envelope);
        }
        await this.#handleEnvelope(envelope, foldedClaim);
        await guard.assertHeld();
        const latest = await getLatestReceipt(this.#ch, claimed.project_id, claimed.receipt_id);
        if (
          latest === null ||
          latest.claim_fence !== lease.fence ||
          latest.state !== 'claimed'
        ) {
          throw new CommunicationError('STALE_RECEIPT_FENCE', 'processed yazimindan once claim stale');
        }
        const processedNext = receiptNext(latest, {
          state: 'processed',
          claim_expires_at: null,
          next_attempt_at: null,
          error: '',
        });
        const processed = await appendReceiptVersion(this.#ch, {
          expectedVersion: latest.receipt_version,
          next: processedNext,
        });
        if (processed.claim_fence !== lease.fence || processed.state !== 'processed') {
          throw new CommunicationError('STALE_RECEIPT_FENCE', 'processed receipt daha yeni fence kaybetti');
        }
        await this.#appendReceiptEvent(processed, envelope, 'processed');
        return Object.freeze({
          state: 'processed',
          recipient,
          messageId: envelope.messageId,
          receiptId: processed.receipt_id,
        });
      } catch (error) {
        if (error instanceof CommunicationError && error.code === 'STALE_RECEIPT_FENCE') {
          return Object.freeze({
            state: 'stale',
            recipient,
            messageId: item.message.envelope.messageId,
            receiptId: initial.receipt_id,
          });
        }
        return await this.#recordFailure(foldedClaim, item.message.envelope, recipient, error, guard);
      }
    } finally {
      await guard.stop();
    }
  }

  async #assertCurrentContext(envelope: AgentMessageEnvelopeV1): Promise<void> {
    const scopeCount = [
      envelope.taskId,
      envelope.taskBriefId,
      envelope.assignmentAttemptId,
    ].filter((value) => value !== undefined).length;
    if (scopeCount === 0) return;
    if (scopeCount !== 3) {
      throw new CommunicationError('STALE_TASK_CONTEXT', 'stored message task baglami eksik');
    }
    const task = await getLatestTask(this.#ch, envelope.projectId, envelope.taskId!);
    const brief = await getTaskBrief(this.#ch, envelope.taskBriefId!);
    const attempt = await getAssignmentAttempt(this.#ch, envelope.assignmentAttemptId!);
    if (
      task === null ||
      brief === null ||
      attempt === null ||
      task.task_brief_id !== envelope.taskBriefId ||
      task.assignment_attempt_id !== envelope.assignmentAttemptId ||
      brief.projectId !== envelope.projectId ||
      brief.taskId !== envelope.taskId ||
      attempt.projectId !== envelope.projectId ||
      attempt.taskId !== envelope.taskId ||
      attempt.taskBriefId !== envelope.taskBriefId ||
      attempt.workerAgentId !== task.worker_agent_id ||
      attempt.verifierAgentId !== task.verifier_agent_id
    ) {
      throw new CommunicationError(
        'STALE_TASK_CONTEXT',
        'stored message current task/brief/attempt fold ile eslesmiyor',
      );
    }
    if (
      envelope.kind !== 'escalation' &&
      brief.deadlineAt !== undefined &&
      Date.parse(brief.deadlineAt) <= Date.parse(this.#clock.now())
    ) {
      throw new CommunicationError('DEADLINE_EXPIRED', 'stored message task brief son tarihi gecmis');
    }
    const statusAllowed =
      (envelope.kind === 'report' && task.status === 'working') ||
      (envelope.kind === 'verdict' && task.status === 'verifying') ||
      (envelope.kind === 'answer' && task.status === 'waiting_user') ||
      (envelope.kind === 'question' && task.status === 'working') ||
      (envelope.kind === 'order' && (task.status === 'assigned' || task.status === 'working')) ||
      envelope.kind === 'escalation' ||
      (envelope.kind === 'user_command' && !['done', 'failed', 'cancelled'].includes(task.status));
    if (!statusAllowed) {
      throw new CommunicationError('STALE_TASK_CONTEXT', 'stored message current task durumunda uygulanamaz');
    }
    if (
      (envelope.kind === 'report' || envelope.kind === 'question') &&
      (
        envelope.authenticatedPrincipal.principalType !== 'agent' ||
        task.worker_agent_id !== envelope.authenticatedPrincipal.principalId
      )
    ) {
      throw new CommunicationError('STALE_TASK_CONTEXT', 'stored worker mesaji current atamaya ait degil');
    }
    if (
      envelope.kind === 'verdict' &&
      (
        envelope.authenticatedPrincipal.principalType !== 'agent' ||
        task.verifier_agent_id !== envelope.authenticatedPrincipal.principalId
      )
    ) {
      throw new CommunicationError('STALE_TASK_CONTEXT', 'stored verdict current verifier atamasina ait degil');
    }
  }

  async #assertStoredAuthorization(
    message: DueInboxItemRecord['message'],
    receipt: MessageReceiptRow,
  ): Promise<void> {
    const envelope = message.envelope;
    const event = await getEvent(this.#ch, communicationPolicyEventId(envelope.messageId));
    if (
      event === null ||
      event.event_type !== 'policy_decision' ||
      event.tool_name !== 'communication_policy' ||
      event.project_id !== envelope.projectId ||
      !isRecord(event.payload) ||
      event.payload['contractVersion'] !== 1 ||
      event.payload['messageId'] !== envelope.messageId ||
      event.payload['intentHash'] !== communicationEnvelopeIntentHash(envelope)
    ) {
      throw new CommunicationError(
        'RECIPIENT_SNAPSHOT_INVALID',
        'stored message deterministic authorization kaydiyla eslesmiyor',
      );
    }
    const decision = PolicyDecisionSchema.safeParse(event.payload['decision']);
    if (!decision.success || !decision.data.allowed) {
      throw new CommunicationError(
        'ROUTE_DENIED',
        'stored message icin typed allow policy karari bulunamadi',
      );
    }
    const principalSnapshot = AuthenticatedPrincipalSnapshotV1Schema.safeParse(
      event.payload['principalSnapshot'],
    );
    if (
      !principalSnapshot.success ||
      canonicalSha256V1(principalSnapshot.data) !==
        canonicalSha256V1(envelope.authenticatedPrincipal)
    ) {
      throw new CommunicationError(
        'RECIPIENT_SNAPSHOT_INVALID',
        'stored principal snapshot envelope ile eslesmiyor',
      );
    }
    const snapshot = event.payload['recipientSnapshot'];
    if (!Array.isArray(snapshot)) {
      throw new CommunicationError('RECIPIENT_SNAPSHOT_INVALID', 'stored recipient snapshot yok');
    }
    const expected = new Map<string, PartyRefV1>();
    for (const value of snapshot) {
      const parsed = PartyRefV1Schema.safeParse(value);
      if (!parsed.success || parsed.data.type === 'broadcast') {
        throw new CommunicationError(
          'RECIPIENT_SNAPSHOT_INVALID',
          'stored policy recipient snapshot gecersiz',
        );
      }
      const receiptId = communicationReceiptId(envelope.messageId, parsed.data);
      if (expected.has(receiptId)) {
        throw new CommunicationError(
          'RECIPIENT_SNAPSHOT_INVALID',
          'stored policy recipient snapshot duplicate alici tasiyor',
        );
      }
      expected.set(receiptId, parsed.data);
    }
    const receipts = await listLatestReceiptsByMessage(
      this.#ch,
      envelope.projectId,
      envelope.messageId,
      { limit: 1_000 },
    );
    const observed = new Set<string>();
    for (const candidate of receipts) {
      const expectedRecipient = expected.get(candidate.receipt_id);
      if (
        expectedRecipient === undefined ||
        observed.has(candidate.receipt_id) ||
        !sameRecipient(expectedRecipient, candidate.recipient_snapshot)
      ) {
        throw new CommunicationError(
          'RECIPIENT_SNAPSHOT_INVALID',
          'stored receipt seti policy recipient snapshotindan sapti',
        );
      }
      observed.add(candidate.receipt_id);
    }
    if (observed.size < expected.size) {
      throw new CommunicationError(
        'RECEIPT_SNAPSHOT_INCOMPLETE',
        'stored receipt seti policy recipient snapshotina henuz tamamlanmadi',
      );
    }
    if (
      observed.size !== expected.size ||
      !observed.has(receipt.receipt_id)
    ) {
      throw new CommunicationError(
        'RECIPIENT_SNAPSHOT_INVALID',
        'current receipt deterministic policy snapshotinda exact bulunmuyor',
      );
    }
    if (envelope.kind === 'report' || envelope.kind === 'verdict') {
      if (
        envelope.authenticatedPrincipal.principalType !== 'agent' ||
        envelope.invocationId === undefined ||
        envelope.taskId === undefined ||
        envelope.taskBriefId === undefined ||
        envelope.assignmentAttemptId === undefined ||
        envelope.promptInputSnapshotId === undefined
      ) {
        throw new CommunicationError(
          'MODEL_PROVENANCE_INVALID',
          'stored agent sonucu invocation provenance tasimiyor',
        );
      }
      let usage: Awaited<ReturnType<typeof getActualModelRefForInvocation>>;
      try {
        usage = await getActualModelRefForInvocation(this.#ch, envelope.invocationId, {
          projectId: envelope.projectId,
          agentId: envelope.authenticatedPrincipal.principalId,
          taskId: envelope.taskId,
          taskBriefId: envelope.taskBriefId,
          assignmentAttemptId: envelope.assignmentAttemptId,
          promptInputSnapshotId: envelope.promptInputSnapshotId,
        });
      } catch (error) {
        if (
          !(error instanceof StoredRecordError) &&
          !(error instanceof RepositoryConflictError)
        ) throw error;
        throw new CommunicationError(
          'MODEL_PROVENANCE_INVALID',
          'stored invocation provenance scope catismasi',
          error,
        );
      }
      if (usage === null || message.actualModelRef !== usage.usedRef) {
        throw new CommunicationError(
          'MODEL_PROVENANCE_INVALID',
          'stored actual model ref authoritative usage ile eslesmiyor',
        );
      }
    }
  }

  async #assertAuthoritativeAnswerWinner(envelope: AgentMessageEnvelopeV1): Promise<void> {
    if (envelope.kind !== 'answer') return;
    const winner = await findAuthoritativeAnswerWinner(
      this.#ch,
      envelope.projectId,
      envelope.replyToMessageId!,
    );
    if (winner === null) {
      throw new CommunicationError(
        'ANSWER_WINNER_PENDING',
        'answer transition authoritative winner tamamlanmadan uygulanamaz',
      );
    }
    if (winner.envelope.messageId !== envelope.messageId) {
      throw new CommunicationError(
        'ANSWER_MISMATCH',
        'answer transition farkli authoritative winner tarafindan kaybedildi',
      );
    }
  }

  async #handleEnvelope(
    envelope: AgentMessageEnvelopeV1,
    receipt: MessageReceiptRow,
  ): Promise<void> {
    const transition = this.#transitionFor(envelope);
    if (transition !== undefined) {
      await this.#effectRunner.run<null>({
        projectId: envelope.projectId,
        taskId: envelope.taskId!,
        assignmentAttemptId: envelope.assignmentAttemptId!,
        causationId: envelope.messageId,
        stableEffectId: this.#stableEffectId(envelope, receipt),
        effectType: 'task_transition_v1',
        request: transition,
        replaySafety: 'replay_safe',
        createdAt: envelope.createdAt,
        execute: async () => {
          await this.#transitionPort.apply(envelope.authenticatedPrincipal, transition);
          return null;
        },
        serialize: (value) => value,
        parse: (value) => {
          if (value !== null) throw new Error('task transition effect sonucu null olmali');
          return null;
        },
      });
      return;
    }
    if (this.#dispatchPort !== undefined) {
      const escalationContext = this.#dispatchPort.replaySafety === 'non_replay_safe'
        ? await this.#effectEscalationContext(envelope)
        : undefined;
      await this.#effectRunner.run<null>({
        projectId: envelope.projectId,
        ...(envelope.taskId === undefined ? {} : { taskId: envelope.taskId }),
        ...(envelope.assignmentAttemptId === undefined
          ? {}
          : { assignmentAttemptId: envelope.assignmentAttemptId }),
        causationId: envelope.messageId,
        stableEffectId: this.#stableEffectId(envelope, receipt),
        effectType: 'message_dispatch_v1',
        request: { messageId: envelope.messageId, envelopeHash: canonicalEnvelopeHash(envelope) },
        replaySafety: this.#dispatchPort.replaySafety,
        ...(escalationContext === undefined ? {} : { escalationContext }),
        createdAt: envelope.createdAt,
        execute: async (context) => {
          await this.#dispatchPort!.handle(envelope, {
            ...context,
            recipient: receipt.recipient_snapshot,
            receiptId: receipt.receipt_id,
          });
          return null;
        },
        serialize: (value) => value,
        parse: (value) => {
          if (value !== null) throw new Error('message dispatch effect sonucu null olmali');
          return null;
        },
      });
      return;
    }
    throw new CommunicationError(
      'EFFECT_FAILED',
      `mesaj turu icin dispatch handler baglanmamis: ${envelope.kind}`,
    );
  }

  async #effectEscalationContext(
    envelope: AgentMessageEnvelopeV1,
  ): Promise<EffectEscalationContextV1> {
    const owningPmId = await this.#resolveOwningPm(envelope);
    return Object.freeze({
      sessionId: envelope.sessionId,
      owningPmId,
      ...(envelope.taskBriefId === undefined ? {} : { taskBriefId: envelope.taskBriefId }),
    });
  }

  async #resolveOwningPm(envelope: AgentMessageEnvelopeV1): Promise<AgentMessageEnvelopeV1['messageId']> {
    let candidateId: string | undefined;
    if (envelope.taskId !== undefined) {
      const task = await getLatestTask(this.#ch, envelope.projectId, envelope.taskId);
      candidateId = task?.issuer_agent_id;
    } else if (envelope.recipient.type === 'agent') {
      const recipient = await getLatestAgent(this.#ch, envelope.projectId, envelope.recipient.id);
      if (recipient?.role === 'pm') candidateId = recipient.agent_id;
    }
    if (candidateId === undefined && envelope.authenticatedPrincipal.principalType === 'agent') {
      const sender = await getLatestAgent(
        this.#ch,
        envelope.projectId,
        envelope.authenticatedPrincipal.principalId,
      );
      candidateId = sender?.role === 'pm' ? sender.agent_id : sender?.parent_agent_id;
    }
    if (candidateId === undefined || candidateId === NIL_UUID) {
      throw new CommunicationError('ESCALATION_UNAVAILABLE', 'owning PM bulunamadi');
    }
    const pm = await getLatestAgent(this.#ch, envelope.projectId, candidateId);
    if (pm === null || pm.role !== 'pm' || pm.status === 'stopped') {
      throw new CommunicationError('ESCALATION_UNAVAILABLE', 'owning PM aktif degil');
    }
    return pm.agent_id;
  }

  #stableEffectId(envelope: AgentMessageEnvelopeV1, receipt: MessageReceiptRow): string {
    const prefix = ['report', 'verdict', 'answer'].includes(envelope.kind)
      ? 'inbox-transition'
      : 'inbox-dispatch';
    return `${prefix}:${envelope.kind}:${receipt.receipt_id}`;
  }

  #transitionFor(envelope: AgentMessageEnvelopeV1): TaskTransitionRequestV1 | undefined {
    if (!['report', 'verdict', 'answer'].includes(envelope.kind)) return undefined;
    if (
      envelope.taskId === undefined ||
      envelope.taskBriefId === undefined ||
      envelope.assignmentAttemptId === undefined
    ) {
      throw new CommunicationError('STALE_TASK_CONTEXT', 'transition mesaji task baglamini tasimiyor');
    }
    const common = {
      protocolVersion: 1 as const,
      transitionRequestId: deterministicAgentEntityId('inbox-transition-request-v1', {
        messageId: envelope.messageId,
        kind: envelope.kind,
      }),
      projectId: envelope.projectId,
      taskId: envelope.taskId,
      taskBriefId: envelope.taskBriefId,
      assignmentAttemptId: envelope.assignmentAttemptId,
      causationId: envelope.messageId,
      requestedAt: envelope.createdAt,
    };
    if (envelope.payload.type === 'report') {
      return TaskTransitionRequestV1Schema.parse({
        ...common,
        action: 'report_result',
        resultSummary: envelope.payload.summary,
        evidenceRefs: envelope.payload.evidenceRefs,
      });
    }
    if (envelope.payload.type === 'verdict') {
      if (envelope.payload.verdict.decision === 'approve') {
        return TaskTransitionRequestV1Schema.parse({
          ...common,
          action: 'verifier_approved',
          verdictMessageId: envelope.messageId,
        });
      }
      return TaskTransitionRequestV1Schema.parse({
        ...common,
        action: 'verifier_rejected',
        verdictMessageId: envelope.messageId,
        reason: envelope.payload.verdict.reasons.map((reason) => reason.message).join('\n'),
      });
    }
    if (envelope.payload.type === 'answer') {
      return TaskTransitionRequestV1Schema.parse({ ...common, action: 'user_answered' });
    }
    throw new CommunicationError('STALE_TASK_CONTEXT', 'kind ve payload transition eslesmesi bozuk');
  }

  async #recordFailure(
    claimed: MessageReceiptRow,
    envelopeValue: AgentMessageEnvelopeV1,
    recipient: PartyRefV1,
    error: unknown,
    guard: ReceiptLeaseGuard,
  ): Promise<ProcessResult> {
    await guard.assertHeld();
    const latest = await getLatestReceipt(this.#ch, claimed.project_id, claimed.receipt_id);
    if (
      latest === null ||
      latest.claim_fence !== guard.lease.fence ||
      latest.state !== 'claimed'
    ) {
      return Object.freeze({
        state: 'stale',
        recipient,
        messageId: envelopeValue.messageId,
        receiptId: claimed.receipt_id,
      });
    }
    if (error instanceof CommunicationError && error.code === 'ANSWER_WINNER_PENDING') {
      const now = this.#clock.now();
      if (
        envelopeValue.deadlineAt !== undefined &&
        Date.parse(envelopeValue.deadlineAt) <= Date.parse(now)
      ) {
        return this.#recordTerminalFailure(
          latest,
          envelopeValue,
          recipient,
          latest.retry_count,
          new CommunicationError(
            'DEADLINE_EXPIRED',
            'answer winner bagimliligi mesaj deadline icinde tamamlanmadi',
          ),
          guard,
        );
      }
      const detail = safeError(error);
      const nextAttemptAt = new Date(Date.parse(now) + this.#backoffBaseMs).toISOString();
      const waiting = await appendReceiptVersion(this.#ch, {
        expectedVersion: latest.receipt_version,
        next: receiptNext(latest, {
          state: 'claimed',
          claim_expires_at: nextAttemptAt,
          retry_count: latest.retry_count,
          next_attempt_at: null,
          error: detail,
        }),
      });
      await this.#appendReceiptEvent(waiting, envelopeValue, 'dependency_wait');
      return Object.freeze({
        state: 'retry_scheduled',
        recipient,
        messageId: envelopeValue.messageId,
        receiptId: waiting.receipt_id,
        retryCount: waiting.retry_count,
        nextAttemptAt,
        error: detail,
      });
    }
    const detail = safeError(error);
    const retryCount = latest.retry_count + 1;
    const terminal = retryCount >= this.#maxRetries || (
      error instanceof CommunicationError &&
      PERMANENT_INBOX_ERROR_CODES.has(error.code)
    );
    if (terminal) {
      return this.#recordTerminalFailure(
        latest,
        envelopeValue,
        recipient,
        retryCount,
        error,
        guard,
      );
    }
    const delay = Math.min(
      this.#backoffBaseMs * (2 ** Math.max(0, retryCount - 1)),
      3_600_000,
    );
    const nextAttemptAt = new Date(Date.parse(this.#clock.now()) + delay).toISOString();
    const retry = await appendReceiptVersion(this.#ch, {
      expectedVersion: latest.receipt_version,
      next: receiptNext(latest, {
        state: 'retry_scheduled',
        claim_expires_at: null,
        retry_count: retryCount,
        next_attempt_at: nextAttemptAt,
        error: detail,
      }),
    });
    await this.#appendReceiptEvent(retry, envelopeValue, 'retry_scheduled');
    return Object.freeze({
      state: 'retry_scheduled',
      recipient,
      messageId: envelopeValue.messageId,
      receiptId: retry.receipt_id,
      retryCount,
      nextAttemptAt,
      error: detail,
    });
  }

  async #recordTerminalFailure(
    latest: MessageReceiptRow,
    envelope: AgentMessageEnvelopeV1,
    recipient: PartyRefV1,
    retryCount: number,
    error: unknown,
    guard: ReceiptLeaseGuard,
  ): Promise<ProcessResult> {
    const detail = safeError(error);
    await this.#appendTerminalEscalation(latest, envelope, retryCount);
    await guard.assertHeld();
    const failed = await appendReceiptVersion(this.#ch, {
      expectedVersion: latest.receipt_version,
      next: receiptNext(latest, {
        state: 'failed',
        claim_expires_at: null,
        retry_count: retryCount,
        next_attempt_at: null,
        error: detail,
      }),
    });
    await this.#appendReceiptEvent(failed, envelope, 'failed');
    return Object.freeze({
      state: 'failed',
      recipient,
      messageId: envelope.messageId,
      receiptId: failed.receipt_id,
      retryCount,
      error: detail,
    });
  }

  async #appendTerminalEscalation(
    receipt: MessageReceiptRow,
    envelope: AgentMessageEnvelopeV1,
    retryCount: number,
  ): Promise<void> {
    if (envelope.kind === 'escalation') return;
    if (this.#receiptEscalationPort === undefined) {
      throw new CommunicationError(
        'ESCALATION_UNAVAILABLE',
        'terminal receipt typed escalation port gerektirir',
      );
    }
    const owningPmId = await this.#resolveOwningPm(envelope);
    await this.#receiptEscalationPort.append(Object.freeze({
      contractVersion: 1,
      projectId: receipt.project_id,
      sessionId: envelope.sessionId,
      ...(envelope.taskId === undefined ? {} : { taskId: envelope.taskId }),
      ...(envelope.taskBriefId === undefined ? {} : { taskBriefId: envelope.taskBriefId }),
      ...(envelope.assignmentAttemptId === undefined
        ? {}
        : { assignmentAttemptId: envelope.assignmentAttemptId }),
      owningPmId,
      causationId: envelope.messageId,
      receiptId: receipt.receipt_id,
      retryCount,
      reasonCode: 'RECEIPT_TERMINAL_FAILURE',
      createdAt: envelope.createdAt,
    }));
  }

  async #appendReceiptEvent(
    receipt: MessageReceiptRow,
    envelope: AgentMessageEnvelopeV1,
    state: 'claimed' | 'processed' | 'retry_scheduled' | 'dependency_wait' | 'failed',
  ): Promise<void> {
    await ensureDurableEvent(this.#ch, {
      event_id: deterministicAgentEntityId('receipt-changed-v1', {
        receiptId: receipt.receipt_id,
        receiptVersion: receipt.receipt_version,
        claimFence: receipt.claim_fence,
      }),
      seq: String(Date.parse(envelope.createdAt)),
      project_id: receipt.project_id,
      task_id: envelope.taskId ?? NIL_UUID,
      agent_id: NIL_UUID,
      event_type: 'receipt_changed',
      tool_name: 'inbox_worker',
      payload: {
        contractVersion: 1,
        receiptId: receipt.receipt_id,
        messageId: envelope.messageId,
        state,
        retryCount: receipt.retry_count,
        claimFence: receipt.claim_fence,
      },
      duration_ms: 0,
      created_at: envelope.createdAt,
    });
  }
}

function canonicalEnvelopeHash(envelope: AgentMessageEnvelopeV1): string {
  return canonicalSha256V1(envelope);
}
