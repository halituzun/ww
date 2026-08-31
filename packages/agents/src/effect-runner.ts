import { randomUUID } from 'node:crypto';
import { notifyUnexpectedError, type UnexpectedErrorObserver } from './unexpected-error-observer.js';
import { toStrictJson } from './strict-json.js';
import {
  JsonValueSchema,
  canonicalSha256V1,
  type JsonValue,
} from '@ww/shared';
import {
  acquireFencedLease,
  appendEffectVersion,
  effectLockKey,
  getEffectDurableMaxLeaseFence,
  getFencedLease,
  getLatestEffect,
  releaseFencedLease,
  renewFencedLease,
  reserveEffect,
  reserveEffectWithEvidence,
  type ClickHouseClient,
  type EffectLedgerRow,
  type FencedLease,
  type WwRedis,
} from '@ww/db';
import {
  CommunicationError,
  DurableEffectExecutionError,
  sanitizePersistedError,
} from './errors.js';
import {
  systemClock,
  type ClockPort,
  type DurableEffectInput,
  type EffectEscalationPort,
} from './ports.js';

export interface EffectRunnerOptions {
  readonly clock?: ClockPort;
  /**
   * Beklenmeyen hatanın HAM hali; yalnızca süreç içi teşhis için.
   * Kalıcı kayıt sansürlü kalır (sağlayıcı/anahtar/prompt sızmaz).
   */
  readonly onUnexpectedError?: UnexpectedErrorObserver;
  readonly escalationPort?: EffectEscalationPort;
  readonly leaseTtlMs?: number;
  readonly contentionWaitMs?: number;
  readonly contentionPollMs?: number;
}

const NON_REPLAY_SAFE_UNCERTAIN_REASON = 'NON_REPLAY_SAFE_EFFECT_UNCERTAIN';
const MIN_EFFECT_LEASE_TTL_MS = 30;

function positiveInteger(value: number, context: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${context} 1-${maximum} araliginda olmalidir`);
  }
  return value;
}

function effectLeaseTtl(value: number): number {
  const parsed = positiveInteger(value, 'leaseTtlMs', 3_600_000);
  if (parsed < MIN_EFFECT_LEASE_TTL_MS) {
    throw new Error(`leaseTtlMs en az ${MIN_EFFECT_LEASE_TTL_MS} olmalidir`);
  }
  return parsed;
}

function assertFenceOwned(row: EffectLedgerRow, leaseFence: string): EffectLedgerRow {
  if (BigInt(row.lease_fence) > BigInt(leaseFence)) {
    throw new CommunicationError('STALE_RECEIPT_FENCE', 'effect daha yeni lease fence altinda');
  }
  return row;
}

function parseResult<T>(row: EffectLedgerRow, input: DurableEffectInput<T>): T {
  try {
    return input.parse(row.result);
  } catch (error) {
    throw new CommunicationError(
      'EFFECT_FAILED',
      'kalici effect sonucu typed parser tarafindan reddedildi',
      error,
    );
  }
}

function effectError(
  code: 'EFFECT_FAILED' | 'EFFECT_UNCERTAIN',
  row: EffectLedgerRow,
): CommunicationError {
  return new CommunicationError(code, row.error.length > 0 ? row.error : `effect ${row.state}`);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class EffectLeaseGuard {
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
      throw new CommunicationError('EFFECT_UNCERTAIN', 'effect lease kaybedildi');
    }
    const current = await getFencedLease(this.#redis, this.lease.lockKey).catch(() => null);
    if (
      current === null ||
      current.owner !== this.lease.owner ||
      current.fence !== this.lease.fence ||
      !await renewFencedLease(this.#redis, this.lease, this.#ttlMs).catch(() => false)
    ) {
      this.#lost = true;
      throw new CommunicationError('EFFECT_UNCERTAIN', 'effect lease stale');
    }
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    if (this.#renewal !== undefined) await this.#renewal.catch(() => false);
    await releaseFencedLease(this.#redis, this.lease).catch(() => false);
  }
}

export class EffectRunner {
  readonly #ch: ClickHouseClient;
  readonly #redis: WwRedis;
  readonly #clock: ClockPort;
  readonly #escalationPort: EffectEscalationPort | undefined;
  readonly #onUnexpectedError: UnexpectedErrorObserver | undefined;
  readonly #leaseTtlMs: number;
  readonly #contentionWaitMs: number;
  readonly #contentionPollMs: number;

  constructor(ch: ClickHouseClient, redis: WwRedis, options: EffectRunnerOptions = {}) {
    this.#ch = ch;
    this.#redis = redis;
    this.#clock = options.clock ?? systemClock;
    this.#escalationPort = options.escalationPort;
    this.#onUnexpectedError = options.onUnexpectedError;
    this.#leaseTtlMs = effectLeaseTtl(options.leaseTtlMs ?? 30_000);
    this.#contentionWaitMs = positiveInteger(
      options.contentionWaitMs ?? 30_000,
      'contentionWaitMs',
      3_600_000,
    );
    this.#contentionPollMs = positiveInteger(
      options.contentionPollMs ?? 10,
      'contentionPollMs',
      10_000,
    );
  }

  async run<T>(input: DurableEffectInput<T>): Promise<T> {
    const createdAt = input.createdAt ?? this.#clock.now();
    if (
      input.replaySafety === 'non_replay_safe' &&
      (this.#escalationPort === undefined || input.escalationContext === undefined)
    ) {
      throw new CommunicationError(
        'ESCALATION_UNAVAILABLE',
        'non-replay-safe effect calismadan once typed escalation baglami gerektirir',
      );
    }
    if (input.replaySafety === 'non_replay_safe') {
      const escalationScopeCount = [
        input.taskId,
        input.assignmentAttemptId,
        input.escalationContext?.taskBriefId,
      ].filter((value) => value !== undefined).length;
      if (escalationScopeCount !== 0 && escalationScopeCount !== 3) {
        throw new CommunicationError(
          'ESCALATION_UNAVAILABLE',
          'non-replay-safe effect task escalation baglami tam olmalidir',
        );
      }
    }
    const lockKey = effectLockKey(input.causationId, input.stableEffectId);
    const deadline = Date.now() + this.#contentionWaitMs;
    let lease: FencedLease | null = null;
    while (lease === null) {
      const observed = await getLatestEffect(this.#ch, input.causationId, input.stableEffectId);
      if (observed?.state === 'succeeded') {
        await this.#assertIntent(input, observed);
        return parseResult(observed, input);
      }
      if (observed?.state === 'failed') {
        await this.#assertIntent(input, observed);
        throw effectError('EFFECT_FAILED', observed);
      }
      if (observed?.state === 'uncertain' && input.replaySafety === 'non_replay_safe') {
        await this.#assertIntent(input, observed);
        await this.#escalate(input, observed.created_at);
        throw effectError('EFFECT_UNCERTAIN', observed);
      }
      const floor = await getEffectDurableMaxLeaseFence(
        this.#ch,
        input.causationId,
        input.stableEffectId,
      );
      lease = await acquireFencedLease(
        this.#redis,
        lockKey,
        `effect:${randomUUID()}`,
        this.#leaseTtlMs,
        floor,
      );
      if (lease !== null) break;
      if (Date.now() >= deadline) {
        throw new CommunicationError('EFFECT_LEASE_UNAVAILABLE', 'effect lease zamaninda alinamadi');
      }
      await wait(this.#contentionPollMs);
    }

    const guard = new EffectLeaseGuard(this.#redis, lease, this.#leaseTtlMs);
    try {
      await guard.assertHeld();
      const before = await getLatestEffect(this.#ch, input.causationId, input.stableEffectId);
      if (before !== null) await this.#assertIntent(input, before);
      const reservation = await reserveEffectWithEvidence(this.#ch, {
        causation_id: input.causationId,
        stable_effect_id: input.stableEffectId,
        project_id: input.projectId,
        ...(input.taskId === undefined ? {} : { task_id: input.taskId }),
        ...(input.assignmentAttemptId === undefined
          ? {}
          : { assignment_attempt_id: input.assignmentAttemptId }),
        effect_type: input.effectType,
        request: input.request,
        replay_safety: input.replaySafety,
        lease_fence: lease.fence,
        created_at: createdAt,
      });
      let current = assertFenceOwned(reservation.row, lease.fence);
      const effectCreatedAt = current.created_at;

      if (current.state === 'succeeded') return parseResult(current, input);
      if (current.state === 'failed') throw effectError('EFFECT_FAILED', current);
      if (
        input.replaySafety === 'non_replay_safe' &&
        (
          current.state === 'uncertain' ||
          (current.state === 'pending' && reservation.hadPriorReservation)
        )
      ) {
        if (current.state === 'pending') {
          current = await this.#appendTerminal(
            current,
            input,
            lease.fence,
            'uncertain',
            new CommunicationError('EFFECT_UNCERTAIN', 'onceki non-replay-safe effect pending'),
            createdAt,
          );
        }
        await this.#escalate(input, effectCreatedAt);
        throw effectError('EFFECT_UNCERTAIN', current);
      }

      const externalIdempotencyKey = canonicalSha256V1({
        contractVersion: 1,
        causationId: input.causationId,
        stableEffectId: input.stableEffectId,
        request: input.request,
      });
      let value: T;
      try {
        value = await input.execute({ externalIdempotencyKey });
        await guard.assertHeld();
      } catch (error) {
        const definite = error instanceof DurableEffectExecutionError &&
          error.outcome === 'definite_failure';
        notifyUnexpectedError(this.#onUnexpectedError, error, {
          effectType: input.effectType,
          stableEffectId: input.stableEffectId,
          state: definite ? 'failed' : 'uncertain',
        });
        current = await this.#appendTerminal(
          current,
          input,
          lease.fence,
          definite ? 'failed' : 'uncertain',
          error,
          createdAt,
        );
        if (!definite && input.replaySafety === 'non_replay_safe') {
          await this.#escalate(input, effectCreatedAt);
        }
        throw effectError(definite ? 'EFFECT_FAILED' : 'EFFECT_UNCERTAIN', current);
      }

      let serialized: JsonValue;
      try {
        // JSON'da undefined yoktur; tek bir tanımsız alan tüm efekti
        // 'uncertain' yapıyordu. Normalleştirme TÜM efekt türleri için burada.
        serialized = JsonValueSchema.parse(toStrictJson(input.serialize(value)));
      } catch (error) {
        notifyUnexpectedError(this.#onUnexpectedError, error, {
          effectType: input.effectType,
          stableEffectId: input.stableEffectId,
          state: 'uncertain',
        });
        current = await this.#appendTerminal(
          current,
          input,
          lease.fence,
          'uncertain',
          error,
          createdAt,
        );
        if (input.replaySafety === 'non_replay_safe') {
          await this.#escalate(input, effectCreatedAt);
        }
        throw effectError('EFFECT_UNCERTAIN', current);
      }

      await guard.assertHeld();
      current = assertFenceOwned(await appendEffectVersion(this.#ch, {
        causation_id: input.causationId,
        stable_effect_id: input.stableEffectId,
        expectedVersion: current.effect_version,
        state: 'succeeded',
        result: serialized,
        error: '',
        lease_fence: lease.fence,
        created_at: createdAt,
      }), lease.fence);
      return parseResult(current, input);
    } finally {
      await guard.stop();
    }
  }

  async #assertIntent<T>(input: DurableEffectInput<T>, row: EffectLedgerRow): Promise<void> {
    await reserveEffect(this.#ch, {
      causation_id: input.causationId,
      stable_effect_id: input.stableEffectId,
      project_id: input.projectId,
      ...(input.taskId === undefined ? {} : { task_id: input.taskId }),
      ...(input.assignmentAttemptId === undefined
        ? {}
        : { assignment_attempt_id: input.assignmentAttemptId }),
      effect_type: input.effectType,
      request: input.request,
      replay_safety: input.replaySafety,
      lease_fence: row.lease_fence,
      created_at: row.created_at,
    });
  }

  async #appendTerminal<T>(
    current: EffectLedgerRow,
    input: DurableEffectInput<T>,
    leaseFence: string,
    state: 'failed' | 'uncertain',
    error: unknown,
    createdAt: string,
  ): Promise<EffectLedgerRow> {
    const persisted = sanitizePersistedError(error);
    return assertFenceOwned(await appendEffectVersion(this.#ch, {
      causation_id: input.causationId,
      stable_effect_id: input.stableEffectId,
      expectedVersion: current.effect_version,
      state,
      result: {},
      error: persisted.serialized,
      lease_fence: leaseFence,
      created_at: createdAt,
    }), leaseFence);
  }

  async #escalate<T>(input: DurableEffectInput<T>, createdAt: string): Promise<void> {
    if (this.#escalationPort === undefined || input.escalationContext === undefined) {
      throw new CommunicationError(
        'ESCALATION_UNAVAILABLE',
        'non-replay-safe effect typed escalation port ve owning PM baglami gerektirir',
      );
    }
    await this.#escalationPort.append(Object.freeze({
      contractVersion: 1,
      projectId: input.projectId,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.assignmentAttemptId === undefined
        ? {}
        : { assignmentAttemptId: input.assignmentAttemptId }),
      sessionId: input.escalationContext.sessionId,
      owningPmId: input.escalationContext.owningPmId,
      ...(input.escalationContext.taskBriefId === undefined
        ? {}
        : { taskBriefId: input.escalationContext.taskBriefId }),
      causationId: input.causationId,
      stableEffectId: input.stableEffectId,
      effectType: input.effectType,
      reason: NON_REPLAY_SAFE_UNCERTAIN_REASON,
      createdAt,
    }));
  }
}
