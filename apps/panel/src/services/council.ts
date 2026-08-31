import { getJson, requestJson, type RequestOptions } from './http.js';

/**
 * Konsey uçları. NEDEN ayrı servis: konsey kararları ve ek tur talebi
 * CouncilTranscriptViewer içinde çıplak `fetch` ile çağrılıyordu — docs/09
 * View'da veri erişimini yasaklar (STD-001) ve tek HTTP katmanı http.ts'tir.
 */

export interface CouncilDecision {
  readonly topic: string;
  readonly decision: 'accepted' | 'rejected' | 'modified';
  readonly rationale: string;
  readonly dissent: string;
  readonly turn_number: number;
}

/** Konseyin karar defteri. Hata YUTULMAZ: boş liste ile hata aynı şey değildir. */
export function fetchCouncilDecisions(
  projectId: string,
  options: RequestOptions = {},
): Promise<readonly CouncilDecision[]> {
  return getJson<readonly CouncilDecision[]>(
    `/projects/${projectId}/decisions`,
    options,
    'Konsey kararları alınamadı',
  );
}

/** Odaklı ek müzakere turu açar. */
export function requestCouncilRound(
  projectId: string,
  focusTopic: string,
  options: RequestOptions = {},
): Promise<unknown> {
  return requestJson<unknown>(
    `/projects/${projectId}/council/rounds`,
    { ...options, method: 'POST', body: { focusTopic } },
    'Ek tur açılamadı',
  );
}
