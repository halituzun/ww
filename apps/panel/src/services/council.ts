import { getJson, requestJson, type RequestOptions } from './http.js';

/**
 * Konsey uçları. NEDEN ayrı servis: konsey kararları ve ek tur talebi
 * CouncilTranscriptViewer içinde çıplak `fetch` ile çağrılıyordu — docs/09
 * View'da veri erişimini yasaklar (STD-001) ve tek HTTP katmanı http.ts'tir.
 */

export interface CouncilEntry {
  readonly speaker: string;
  readonly role: string;
  readonly model: string;
  readonly stance: "proposal" | "objection" | "draft" | "red_team" | "final" | "research" | "debate";
  readonly text: string;
}

export interface CouncilRoundData {
  readonly round: number;
  readonly title: string;
  readonly badge: string;
  readonly summary: string;
  readonly entries: readonly CouncilEntry[];
  readonly decision?: string | undefined;
  readonly dissent?: string | undefined;
  readonly isResearch?: boolean | undefined;
  readonly isUncoordinated?: boolean | undefined;
}

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

/**
 * Konsey oturumunu başlatır ve plan üretir.
 *
 * NEDEN VAR: panelde `POST /projects/:id/council` çağıran HİÇBİR fonksiyon
 * yoktu; konsey yalnız `curl` ile başlatılabiliyordu. docs/11 Faz 4'ün
 * "sihirbazdan girilir -> konsey planlar" zinciri bu yüzden uçtan uca
 * yürümüyordu.
 *
 * Uzun sürer (turlar gerçek model çağrısıdır); çağıran taraf ilerlemeyi
 * göstermelidir.
 */
export function runCouncil(
  projectId: string,
  goal: string,
  options: RequestOptions = {},
): Promise<unknown> {
  return requestJson<unknown>(
    `/projects/${projectId}/council`,
    { ...options, method: 'POST', body: { goal } },
    'Konsey oturumu başlatılamadı',
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
