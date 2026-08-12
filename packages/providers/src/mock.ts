import { createHash } from 'node:crypto';
import {
  ProviderError,
  type CompletionRequest,
  type CompletionResult,
  type HealthResult,
  type LlmProvider,
  type NormalizedToolCall,
} from './types.js';

export interface MockScriptItem {
  content: string | null;
  toolCalls: NormalizedToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
}

export interface MockOptions {
  // Sabit liste veya isteğe göre cevap üreten fonksiyon.
  script: MockScriptItem[] | ((req: CompletionRequest, callIndex: number) => MockScriptItem);
  failFirst?: number; // ilk n çağrıda retryable ProviderError fırlat (fallback testleri)
  failKind?: 'connection' | 'server' | 'rate_limited' | 'timeout' | 'bad_request' | 'auth';
}

// Deterministik sahte sağlayıcı: entegrasyon testlerinin temeli (docs/11 → Faz 0).
export class MockProvider implements LlmProvider {
  readonly id = 'mock';
  readonly calls: CompletionRequest[] = [];
  private idx = 0;
  private failures = 0;

  constructor(private opts: MockOptions) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(req);
    if (this.opts.failFirst !== undefined && this.failures < this.opts.failFirst) {
      this.failures += 1;
      throw new ProviderError('mock failure', this.opts.failKind ?? 'server');
    }
    const item =
      typeof this.opts.script === 'function'
        ? this.opts.script(req, this.idx)
        : this.opts.script[this.idx];
    if (!item) throw new Error(`mock senaryosu tükendi (çağrı ${this.idx + 1})`);
    this.idx += 1;
    return {
      content: item.content,
      toolCalls: item.toolCalls,
      usage: item.usage ?? { promptTokens: 10, completionTokens: 5 },
    };
  }

  // Metin hash'inden deterministik 16 boyutlu vektör.
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const h = createHash('sha256').update(t).digest();
      return Array.from({ length: 16 }, (_, i) => (h[i]! - 128) / 128);
    });
  }

  async healthCheck(): Promise<HealthResult> {
    return { ok: true, latencyMs: 0 };
  }

  listModels(): string[] {
    return ['mock-model'];
  }
}
