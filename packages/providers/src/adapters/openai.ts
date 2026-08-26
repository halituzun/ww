function stripThinkingBlocks(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  // <think>...</think> veya <thought>...</thought> bloklarını temizler
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();
  return cleaned.length > 0 ? cleaned : null;
}
import OpenAI from 'openai';
import { mapError } from './errors.js';
import {
  fromOpenAiToolCalls,
  toOpenAiMessages,
  toOpenAiTools,
} from './normalize.js';
import type {
  CompletionRequest,
  CompletionResult,
  HealthResult,
  LlmProvider,
} from '../types.js';

export interface OpenAiAdapterOptions {
  apiKey: string;
  baseURL?: string;
  id?: string; // DeepSeek gibi OpenAI-uyumlu uçlar bu adaptörü farklı id ile kullanır
  models?: string[];
  healthModel?: string;
  embeddingModel?: string;
}

export class OpenAiAdapter implements LlmProvider {
  readonly id: string;
  private readonly client: OpenAI;
  private readonly models: string[];

  constructor(private readonly opts: OpenAiAdapterOptions) {
    this.id = opts.id ?? 'openai';
    this.models = opts.models ?? ['gpt-5', 'gpt-5-mini'];
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      ...(opts.baseURL === undefined ? {} : { baseURL: opts.baseURL }),
    });
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    try {
      const res = await this.client.chat.completions.create({
        model: req.model,
        messages: toOpenAiMessages(req.messages) as never,
        ...(toOpenAiTools(req.tools) === undefined ? {} : { tools: toOpenAiTools(req.tools) as never }),
        ...(req.maxTokens === undefined ? {} : { max_completion_tokens: req.maxTokens }),
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      });
      const choice = res.choices[0];
      return {
        content: stripThinkingBlocks(choice?.message.content),
        toolCalls: fromOpenAiToolCalls(
          choice?.message.tool_calls as { id: string; function: { name: string; arguments: string } }[] | undefined,
        ),
        usage: {
          promptTokens: res.usage?.prompt_tokens ?? 0,
          completionTokens: res.usage?.completion_tokens ?? 0,
        },
        raw: res,
      };
    } catch (e) {
      throw mapError(e, this.id);
    }
  }

  async embed(texts: string[], model?: string): Promise<number[][]> {
    try {
      const res = await this.client.embeddings.create({
        model: model ?? this.opts.embeddingModel ?? 'text-embedding-3-small',
        input: texts,
      });
      return res.data.map((d) => d.embedding);
    } catch (e) {
      throw mapError(e, this.id);
    }
  }

  async healthCheck(): Promise<HealthResult> {
    const t0 = Date.now();
    try {
      await this.client.chat.completions.create({
        model: this.opts.healthModel ?? this.models[0]!,
        messages: [{ role: 'user', content: 'ping' }],
        max_completion_tokens: 1,
      });
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, error: mapError(e, this.id).message };
    }
  }

  listModels(): string[] {
    return [...this.models];
  }
}
