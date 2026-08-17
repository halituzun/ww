import {
  EntityIdSchema,
  JsonValueSchema,
  type EntityId,
} from '@ww/shared';
import { ProviderError, type ProviderInvocationEffect } from '@ww/providers';
import { canonicalSha256V1 } from '@ww/shared';
import { DurableEffectExecutionError } from './errors.js';
import { toStrictJson } from './strict-json.js';
import { EffectRunner } from './effect-runner.js';

export interface ProviderEffectContext {
  readonly sessionId: EntityId;
  readonly owningPmId: EntityId;
}

/** Narrow adapter keeping provider calls behind the existing durable ledger. */
export class DurableProviderInvocationEffect implements ProviderInvocationEffect {
  constructor(
    private readonly runner: EffectRunner,
    private readonly context: ProviderEffectContext,
  ) {}

  async run<T>(input: Parameters<ProviderInvocationEffect['run']>[0]): Promise<T> {
    const request = input.request;
    const meta = request.meta;
    const projectId = EntityIdSchema.parse(meta.projectId);
    const taskId = meta.taskId === undefined ? undefined : EntityIdSchema.parse(meta.taskId);
    const attemptId = EntityIdSchema.parse(meta.assignmentAttemptId);
    const invocationId = EntityIdSchema.parse(input.invocationId);
    let retryableProviderError: ProviderError | undefined;
    try {
      return await this.runner.run<T>({
      projectId,
      ...(taskId === undefined ? {} : { taskId }),
      assignmentAttemptId: attemptId,
      causationId: invocationId,
      // Bir worker döngüsü AYNI invocation içinde birden çok model çağrısı
      // yapar (araç turu, sonra rapor). Anahtar yalnızca invocation+fallback
      // olunca ikinci çağrı birincinin anahtarını kullanıyor ve defter
      // "effect anahtari farkli istekle kullanildi" ile reddediyordu.
      // İstek özeti anahtara girer: aynı istek aynı anahtarı (idempotent
      // yeniden deneme), farklı istek farklı anahtarı alır.
      stableEffectId: `provider-invocation:${invocationId}:${input.fallbackAttempt}:${canonicalSha256V1({ modelRef: input.modelRef, request }).slice(0, 16)}`,
      effectType: 'provider_completion_v1',
      request: { modelRef: input.modelRef, request },
      replaySafety: 'non_replay_safe',
      escalationContext: {
        sessionId: this.context.sessionId,
        owningPmId: this.context.owningPmId,
        ...(meta.taskBriefId === undefined ? {} : { taskBriefId: EntityIdSchema.parse(meta.taskBriefId) }),
      },
      execute: async () => {
        try {
          return await input.execute() as T;
        } catch (error) {
          if (error instanceof ProviderError && error.kind !== 'timeout') {
            retryableProviderError = error;
            throw new DurableEffectExecutionError('definite_failure', 'provider retryable failure', error);
          }
          throw error;
        }
      },
      // JSON'da undefined yoktur; tek bir tanımsız alan efekti 'uncertain'
      // yapıp model çağrısını hiç tamamlatmıyordu.
      serialize: (value) => JsonValueSchema.parse(toStrictJson(value)),
      parse: (value) => value as T,
      });
    } catch (error) {
      if (retryableProviderError !== undefined) throw retryableProviderError;
      throw error;
    }
  }

  async reconcile(input: Parameters<NonNullable<ProviderInvocationEffect['reconcile']>>[0]): Promise<void> {
    const meta = input.request.meta;
    const projectId = EntityIdSchema.parse(meta.projectId);
    const taskId = meta.taskId === undefined ? undefined : EntityIdSchema.parse(meta.taskId);
    const attemptId = EntityIdSchema.parse(meta.assignmentAttemptId);
    const invocationId = EntityIdSchema.parse(input.invocationId);
    await this.runner.run({
      projectId,
      ...(taskId === undefined ? {} : { taskId }),
      assignmentAttemptId: attemptId,
      causationId: invocationId,
      stableEffectId: `provider-usage-reconciliation:${invocationId}`,
      effectType: 'provider_usage_reconciliation_v1',
      request: {
        modelRef: input.modelRef,
        invocationId,
        requestMeta: meta,
        usage: input.usage ?? null,
        latencyMs: input.latencyMs ?? null,
        error: String(input.error),
      },
      replaySafety: 'replay_safe',
      execute: async () => ({ reconciled: false }),
      // JSON'da undefined yoktur; tek bir tanımsız alan efekti 'uncertain'
      // yapıp model çağrısını hiç tamamlatmıyordu.
      serialize: (value) => JsonValueSchema.parse(toStrictJson(value)),
      parse: (value) => value as { reconciled: boolean },
    });
  }
}
