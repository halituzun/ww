import {
  EntityIdSchema,
  JsonValueSchema,
  type EntityId,
} from '@ww/shared';
import { ProviderError, type ProviderInvocationEffect } from '@ww/providers';
import { DurableEffectExecutionError } from './errors.js';
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
      stableEffectId: `provider-invocation:${invocationId}:${input.fallbackAttempt}`,
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
      serialize: (value) => JsonValueSchema.parse(value),
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
      serialize: (value) => JsonValueSchema.parse(value),
      parse: (value) => value as { reconciled: boolean },
    });
  }
}
