import type { ApiUsageRow } from '@ww/shared';
import { NIL_UUID, ProviderInvocationProvenanceV1Schema } from '@ww/shared';
import { costUsd } from './pricing.js';
import { newUsageId, type UsageSink } from './usage.js';
import {
  ProviderError,
  splitRef,
  type CompletionRequest,
  type CompletionResult,
  type LlmProvider,
  ProviderUsageReconciliationError,
  type ProviderInvocationEffect,
} from './types.js';

export interface RouterOptions {
  fallbacks: (modelRef: string) => string[];
  usageSink: UsageSink;
  timeoutMs?: number;
  invocationEffect?: ProviderInvocationEffect;
}

export interface RouteResult {
  result: CompletionResult;
  usedRef: string;
  actualModelRef: string;
  fallbackUsed: boolean;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProviderError(`zaman aşımı (${ms}ms)`, 'timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errStatus(e: unknown): ApiUsageRow['status'] {
  if (e instanceof ProviderError) {
    if (e.kind === 'rate_limited') return 'rate_limited';
    if (e.kind === 'timeout') return 'timeout';
  }
  return 'error';
}

const errKind = (e: unknown): string =>
  e instanceof ProviderError ? e.kind : e instanceof Error ? e.name : 'unknown';

// Tüm LLM çağrıları buradan geçer: fallback zinciri + api_usage kaydı (docs/04-model-katmani.md).
export class ModelRouter {
  constructor(
    private readonly providers: Map<string, LlmProvider>,
    private readonly opts: RouterOptions,
  ) {}

  async complete(modelRef: string, req: Omit<CompletionRequest, 'model'>): Promise<RouteResult> {
    if (req.meta.purpose === 'completion') {
      if (this.opts.invocationEffect === undefined) {
        throw new Error('completion durable effect boundary gerekli');
      }
      const provenance = ['invocationId', 'taskBriefId', 'assignmentAttemptId', 'promptInputSnapshotId'] as const;
      for (const key of provenance) {
        if (req.meta[key] === undefined || req.meta[key] === '') {
          throw new Error(`completion provenance zorunlu: ${key}`);
        }
      }
    }
    const chain = [modelRef, ...this.opts.fallbacks(modelRef)];
    let lastErr: unknown = new Error(`kullanılabilir sağlayıcı yok: ${modelRef}`);

    for (const [i, ref] of chain.entries()) {
      const { providerId, model } = splitRef(ref);
      const provider = this.providers.get(providerId);
      if (!provider) continue;

      const t0 = Date.now();
      const attemptRequest = {
        ...req,
        model,
        meta: {
          ...req.meta,
          ...(req.meta.purpose === 'completion' ? { fallbackAttempt: i } : {}),
        },
      };
      if (attemptRequest.meta.purpose === 'completion') {
        ProviderInvocationProvenanceV1Schema.parse({
          invocationId: attemptRequest.meta.invocationId,
          taskBriefId: attemptRequest.meta.taskBriefId,
          assignmentAttemptId: attemptRequest.meta.assignmentAttemptId,
          promptInputSnapshotId: attemptRequest.meta.promptInputSnapshotId,
          fallbackAttempt: i,
        });
      }
      let result: CompletionResult;
      try {
        result = await (this.opts.invocationEffect === undefined
          ? withTimeout(provider.complete(attemptRequest), this.opts.timeoutMs ?? 120_000)
          : this.opts.invocationEffect.run({
            invocationId: req.meta.invocationId ?? '',
            fallbackAttempt: i,
            modelRef: ref,
            request: attemptRequest,
            execute: () => withTimeout(provider.complete(attemptRequest), this.opts.timeoutMs ?? 120_000),
          }));
      } catch (e) {
        lastErr = e;
        await this.record(
          ref,
          attemptRequest,
          { promptTokens: 0, completionTokens: 0 },
          Date.now() - t0,
          errStatus(e),
          errKind(e),
        );
        // Provider-level retryable failures are a completed durable attempt
        // and may advance the explicit fallback chain. Ledger failures
        // (uncertain/reconciliation) are terminal and never do so.
        if (!(e instanceof ProviderError)) throw e;
        // Kalıcı hatalarda (kötü istek / kimlik) yedek denemek anlamsız.
        if (e instanceof ProviderError && !e.retryable) throw e;
        continue;
      }
      try {
        await this.record(ref, attemptRequest, result.usage, Date.now() - t0, i > 0 ? 'fallback_used' : 'ok', '');
      } catch (error) {
        // A completed provider call is never repeated because its usage write
        // failed; reconciliation can repair the sink later.
        await this.opts.invocationEffect?.reconcile?.({
          invocationId: req.meta.invocationId ?? '',
          modelRef: ref,
          request: attemptRequest,
          error,
          usage: result.usage,
          latencyMs: Date.now() - t0,
        }).catch(() => undefined);
        throw new ProviderUsageReconciliationError(req.meta.invocationId ?? '', error);
      }
      return { result, usedRef: ref, actualModelRef: ref, fallbackUsed: i > 0 };
    }
    throw lastErr;
  }

  private async record(
    modelRef: string,
    req: Omit<CompletionRequest, 'model'>,
    usage: { promptTokens: number; completionTokens: number },
    latencyMs: number,
    status: ApiUsageRow['status'],
    errorKind: string,
  ): Promise<void> {
    const { providerId, model } = splitRef(modelRef);
    const { cost } = costUsd(modelRef, usage);
    await this.opts.usageSink({
      usage_id: newUsageId(),
      project_id: req.meta.projectId,
      agent_id: req.meta.agentId,
      task_id: req.meta.taskId ?? NIL_UUID,
      provider_id: providerId,
      model,
      purpose: req.meta.purpose,
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      cost_usd: cost,
      latency_ms: latencyMs,
      status,
      error_kind: errorKind,
      ...(req.meta.invocationId === undefined ? {} : { invocation_id: req.meta.invocationId }),
      ...(req.meta.taskBriefId === undefined ? {} : { task_brief_id: req.meta.taskBriefId }),
      ...(req.meta.assignmentAttemptId === undefined ? {} : { assignment_attempt_id: req.meta.assignmentAttemptId }),
      ...(req.meta.promptInputSnapshotId === undefined ? {} : { prompt_input_snapshot_id: req.meta.promptInputSnapshotId }),
      ...(req.meta.fallbackAttempt === undefined ? {} : { fallback_attempt: req.meta.fallbackAttempt }),
    });
  }
}
