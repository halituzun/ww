// Görev brief'inin araç ve kabul kriteri politikası.
//
// NEDEN VAR: varsayılan politika `allowedTools: []` veriyordu — yani worker'ın
// HİÇBİR aracı yoktu. Model kodu üretiyor ama dosyaya yazamıyor, sadece metin
// döndürüyordu; verifier de diff'i okumak için git_diff çağırınca "mühürlü
// brief içinde izinli değil" ile düşüyordu. Araçsız bir worker, iş yapıyor
// görünüp hiçbir şey üretmez.
import type { TaskRowLike } from './task-brief-policy-types.js';

/**
 * Worker'ın asgari kümesi. `ask_question` ve `report_result` İLETİŞİM
 * araçlarıdır ama yine de izinli listede olmalı: worker döngüsü model'in
 * istediği aracı bu listeye göre süzer ve eksik olunca "model kayıtlı olmayan
 * aracı istedi: report_result" ile düşüyordu — yani worker işini bitiremiyordu.
 */
export const WORKER_TOOLS = [
  'read_file', 'write_file', 'edit_file', 'ask_question', 'report_result',
] as const;
/** Verifier diff'i bunlarla okur (salt-okuma sınırı tool-factory'de). */
export const VERIFIER_TOOLS = ['git_diff'] as const;

export interface BriefPolicyResult {
  readonly acceptanceCriteria: readonly string[];
  readonly allowedTools: readonly string[];
  readonly ruleRefs: readonly unknown[];
  readonly standardKnowledgeIds: readonly string[];
  readonly requirementKnowledgeIds: readonly string[];
}

export function resolveBriefPolicy(
  task: TaskRowLike,
  ruleRefs: readonly unknown[],
): BriefPolicyResult {
  const criteria = task.acceptance_criteria.length > 0
    ? [...task.acceptance_criteria]
    // Kabul kriteri olmadan verifier neyi onaylayacağını bilemez.
    : [task.description.trim() || task.title];

  return Object.freeze({
    acceptanceCriteria: Object.freeze(criteria),
    allowedTools: Object.freeze([...WORKER_TOOLS, ...VERIFIER_TOOLS]),
    ruleRefs,
    standardKnowledgeIds: Object.freeze([]),
    requirementKnowledgeIds: Object.freeze([]),
  });
}
