import type { ApiUsageRow } from '@ww/shared';
import { NIL_UUID } from '@ww/shared';
import { costUsd } from './pricing.js';
import { newUsageId, type UsageSink } from './usage.js';
import {
  ProviderError,
  splitRef,
  type CompletionRequest,
  type CompletionResult,
  type LlmProvider,
} from './types.js';

export interface RouterOptions {
  fallbacks: (modelRef: string) => string[];
  usageSink: UsageSink;
  timeoutMs?: number;
}

export interface RouteResult {
  result: CompletionResult;
  usedRef: string;
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
    const chain = [modelRef, ...this.opts.fallbacks(modelRef)];
    let lastErr: unknown = new Error(`kullanılabilir sağlayıcı yok: ${modelRef}`);

    for (const [i, ref] of chain.entries()) {
      const { providerId, model } = splitRef(ref);
      const provider = this.providers.get(providerId);
      if (!provider) continue;

      const t0 = Date.now();
      try {
        const result = await withTimeout(
          provider.complete({ ...req, model }),
          this.opts.timeoutMs ?? 120_000,
        );
        await this.record(ref, req, result.usage, Date.now() - t0, i > 0 ? 'fallback_used' : 'ok', '');
        return { result, usedRef: ref, fallbackUsed: i > 0 };
      } catch (e) {
        lastErr = e;
        await this.record(
          ref,
          req,
          { promptTokens: 0, completionTokens: 0 },
          Date.now() - t0,
          errStatus(e),
          errKind(e),
        );
        // Kalıcı hatalarda (kötü istek / kimlik) yedek denemek anlamsız.
        if (e instanceof ProviderError && !e.retryable) throw e;
      }
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
    });
  }
}
