// Provider soyutlaması — docs/04-model-katmani.md arayüzü ile birebir.

import type {
  PromptMessageV1,
  ProviderInvocationProvenanceV1,
} from '@ww/shared';

export interface NormalizedToolCall {
  readonly id: string;
  readonly name: string;
  // Provider output remains untrusted until toPromptToolCallV1 validates it.
  readonly args: unknown;
}

export type ChatMessage = PromptMessageV1;

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface CompletionMeta extends Partial<ProviderInvocationProvenanceV1> {
  projectId: string;
  agentId: string;
  taskId?: string;
  purpose: 'completion' | 'embedding' | 'health_check';
}

/** Durable boundary supplied by the orchestration layer. Providers must not
 * invent or change invocation identity; the router supplies the fallback
 * attempt while keeping the invocation id stable. */
export interface ProviderInvocationEffect {
  run<T>(input: {
    readonly invocationId: string;
    readonly fallbackAttempt: number;
    readonly modelRef: string;
    readonly request: CompletionRequest;
    readonly execute: () => Promise<T>;
  }): Promise<T>;
  /** Records a durable attribution/sink reconciliation item. */
  reconcile?(input: {
    readonly invocationId: string;
    readonly modelRef: string;
    readonly request: CompletionRequest;
    readonly error: unknown;
    readonly usage?: { readonly promptTokens: number; readonly completionTokens: number };
    readonly latencyMs?: number;
  }): Promise<void>;
}

export class ProviderUsageReconciliationError extends Error {
  readonly code = 'PROVIDER_USAGE_RECONCILIATION_FAILED';
  constructor(readonly invocationId: string, cause: unknown) {
    super(`provider usage kaydi uzlastirilamadi: ${invocationId}`, { cause });
    this.name = 'ProviderUsageReconciliationError';
  }
}

export interface CompletionRequest {
  model: string;
  messages: readonly ChatMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
  meta: CompletionMeta;
}

export interface CompletionResult {
  content: string | null;
  toolCalls: NormalizedToolCall[];
  usage: { promptTokens: number; completionTokens: number };
  raw?: unknown;
}

export interface HealthResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface LlmProvider {
  readonly id: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  embed(texts: string[], model?: string): Promise<number[][]>;
  healthCheck(): Promise<HealthResult>;
  listModels(): string[];
}

export type ProviderErrorKind = 'connection' | 'server' | 'rate_limited' | 'timeout' | 'bad_request' | 'auth';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  /** AYNI sağlayıcıyı tekrar denemek anlamlı mı? Kimlik hatasında değildir. */
  get retryable(): boolean {
    return this.kind !== 'bad_request' && this.kind !== 'auth';
  }

  /**
   * BAŞKA bir sağlayıcıya geçmek anlamlı mı? `retryable` ile karıştırılmamalıdır:
   * kimlik hatası O SAĞLAYICIYA özgüdür, yedeğin anahtarı farklıdır ve docs/04
   * "düşen sağlayıcıda işler varsayılana akar" der. Yalnızca kötü istek her
   * sağlayıcıda aynı şekilde düşer; zinciri sadece o keser.
   */
  get advancesFallbackChain(): boolean {
    return this.kind !== 'bad_request';
  }
}

// 'openai:gpt-5' → { providerId: 'openai', model: 'gpt-5' }
export function splitRef(modelRef: string): { providerId: string; model: string } {
  const i = modelRef.indexOf(':');
  if (i <= 0) throw new Error(`geçersiz model_ref: ${modelRef}`);
  return { providerId: modelRef.slice(0, i), model: modelRef.slice(i + 1) };
}
