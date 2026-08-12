import Anthropic from '@anthropic-ai/sdk';
import { mapError } from './errors.js';
import {
  fromAnthropicContent,
  toAnthropicMessages,
  toAnthropicTools,
  type AnthropicBlock,
} from './normalize.js';
import {
  ProviderError,
  type CompletionRequest,
  type CompletionResult,
  type HealthResult,
  type LlmProvider,
} from '../types.js';

export interface AnthropicAdapterOptions {
  apiKey: string;
  baseURL?: string;
  models?: string[];
  healthModel?: string;
}

export class AnthropicAdapter implements LlmProvider {
  readonly id = 'anthropic';
  private readonly client: Anthropic;
  private readonly models: string[];

  constructor(private readonly opts: AnthropicAdapterOptions) {
    this.models = opts.models ?? ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.baseURL === undefined ? {} : { baseURL: opts.baseURL }),
    });
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    try {
      const { system, messages } = toAnthropicMessages(req.messages);
      const res = await this.client.messages.create({
        model: req.model,
        max_tokens: req.maxTokens ?? 8192, // Anthropic'te zorunlu alan
        messages: messages as never,
        ...(system === undefined ? {} : { system }),
        ...(toAnthropicTools(req.tools) === undefined ? {} : { tools: toAnthropicTools(req.tools) as never }),
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      });
      const { content, toolCalls } = fromAnthropicContent(res.content as unknown as AnthropicBlock[]);
      return {
        content,
        toolCalls,
        usage: { promptTokens: res.usage.input_tokens, completionTokens: res.usage.output_tokens },
        raw: res,
      };
    } catch (e) {
      throw mapError(e, this.id);
    }
  }

  // Anthropic embedding uçları sunmaz; embedding sağlayıcısı ayrı seçilir (docs/04).
  async embed(): Promise<number[][]> {
    throw new ProviderError('anthropic embedding desteklemiyor', 'bad_request');
  }

  async healthCheck(): Promise<HealthResult> {
    const t0 = Date.now();
    try {
      await this.client.messages.create({
        model: this.opts.healthModel ?? this.models[this.models.length - 1]!,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
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
