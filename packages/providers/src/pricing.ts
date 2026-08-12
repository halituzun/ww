// Fiyat tablosu ($/1M token) — elle bakımlı (docs/04-model-katmani.md).
// Kaynak: sağlayıcı fiyat sayfaları; model eklerken burayı güncelle.
export interface Price {
  inPerMTok: number;
  outPerMTok: number;
}

export const PRICING: Record<string, Price> = {
  'openai:gpt-5': { inPerMTok: 1.25, outPerMTok: 10 },
  'openai:gpt-5-mini': { inPerMTok: 0.25, outPerMTok: 2 },
  'openai:text-embedding-3-small': { inPerMTok: 0.02, outPerMTok: 0 },
  'anthropic:claude-opus-5': { inPerMTok: 15, outPerMTok: 75 },
  'anthropic:claude-sonnet-5': { inPerMTok: 3, outPerMTok: 15 },
  'anthropic:claude-haiku-4-5-20251001': { inPerMTok: 1, outPerMTok: 5 },
  'deepseek:deepseek-chat': { inPerMTok: 0.27, outPerMTok: 1.1 },
  'deepseek:deepseek-reasoner': { inPerMTok: 0.55, outPerMTok: 2.19 },
  'mock:mock-model': { inPerMTok: 0, outPerMTok: 0 },
};

export function costUsd(
  modelRef: string,
  u: { promptTokens: number; completionTokens: number },
): { cost: number; known: boolean } {
  const p = PRICING[modelRef];
  if (!p) return { cost: 0, known: false };
  return {
    cost: (u.promptTokens * p.inPerMTok + u.completionTokens * p.outPerMTok) / 1_000_000,
    known: true,
  };
}
