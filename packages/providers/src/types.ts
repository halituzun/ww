// Provider soyutlaması — docs/04-model-katmani.md arayüzü ile birebir.

export interface NormalizedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string; // role='tool' iken hangi çağrının sonucu
  toolCalls?: NormalizedToolCall[]; // role='assistant' iken modelin istediği çağrılar
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface CompletionMeta {
  projectId: string;
  agentId: string;
  taskId?: string;
  purpose: 'completion' | 'embedding' | 'health_check';
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
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

  get retryable(): boolean {
    return this.kind !== 'bad_request' && this.kind !== 'auth';
  }
}

// 'openai:gpt-5' → { providerId: 'openai', model: 'gpt-5' }
export function splitRef(modelRef: string): { providerId: string; model: string } {
  const i = modelRef.indexOf(':');
  if (i <= 0) throw new Error(`geçersiz model_ref: ${modelRef}`);
  return { providerId: modelRef.slice(0, i), model: modelRef.slice(i + 1) };
}
