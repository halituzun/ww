import { canonicalSha256V1, type EntityId } from '@ww/shared';

export interface NarratorEvidence { readonly source: string; readonly summary: string; readonly createdAt: string; }
export interface NarratorInput { readonly projectId: EntityId; readonly question: string; readonly evidence: readonly NarratorEvidence[]; readonly cutoffAt?: string; }
export interface NarratorResult { readonly answer: string; readonly evidenceRefs: readonly string[]; readonly traceHash: string; }

/** Evidence-only narrator core. LLM prose can be injected later; this layer
 * guarantees that an answer never claims facts outside the bounded evidence. */
export class NarratorService {
  answer(input: NarratorInput): NarratorResult {
    const cutoff = input.cutoffAt === undefined ? undefined : Date.parse(input.cutoffAt);
    if (input.question.trim().length === 0) throw new Error('narrator sorusu bos olamaz');
    const evidence = input.evidence.filter((item) => cutoff === undefined || Date.parse(item.createdAt) <= cutoff).slice(0, 50);
    const answer = evidence.length === 0
      ? 'Bu soruyu yanitlamak icin yeterli kanit bulunamadi.'
      : evidence.map((item) => item.summary.trim()).filter(Boolean).join(' ');
    const evidenceRefs = evidence.map((item) => item.source);
    return Object.freeze({ answer, evidenceRefs: Object.freeze(evidenceRefs), traceHash: canonicalSha256V1({ projectId: input.projectId, question: input.question.trim(), evidenceRefs }) });
  }
}
