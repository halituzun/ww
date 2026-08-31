// Görev bağlam bütçesi.
//
// NEDEN VAR: bütçe hesabı tek bir satırdaydı ve üretimde HER görev için
// 500 token'a çöküyordu:
//
//   tokenBudget: Math.max(500, Math.floor((scope.tokenBudget ?? 4_000) / 4))
//
// `tasks.token_budget` şeması `UInt32 DEFAULT 0` ve her üretim yolu sıfır
// yazıyor (orchestration.module `budget: 0`, standards-audit `token_budget: 0`).
// `0` nullish OLMADIĞI için `?? 4_000` hiç devreye girmiyor: floor(0/4)=0,
// max(500,0)=500. docs/06'nın vaat ettiği 24k worker bağlamı, pratikte 500
// tahmini token demekti — yalnız tohumlanmış altı standart bile ~550 token.
//
// Hiçbir test bunu yakalamıyordu çünkü entegrasyon testleri açıkça
// `tokenBudget: 4_000` / `8_000` veriyor; üretim değerini koşan test yoktu.
//
// Üstelik aynı `0` modele "sınırsız" diye yazılıyordu: modele sınırsız
// denirken bağlam kurucuya asgari veriliyordu.

import type { AgentRole } from '@ww/shared';

/**
 * `tasks.token_budget = 0` ne demektir: "belirtilmedi", sınırsız DEĞİL.
 * Sıfırı sınırsız saymak, freni olmayan bir görevi bütçeliymiş gibi
 * göstermekti.
 */
export const TASK_BUDGET_UNSET = 0;

/** Rol başına varsayılan görev bütçesi (docs/06: worker 24k). */
const ROLE_DEFAULT_TASK_BUDGET: Readonly<Record<string, number>> = Object.freeze({
  worker: 24_000,
  verifier: 16_000,
  pm: 12_000,
  group_lead: 12_000,
  standards_auditor: 12_000,
});

const FALLBACK_TASK_BUDGET = 16_000;

/** Bağlamın alabileceği pay: kalan yer işe (araç çağrıları, çıktı) kalmalı. */
const CONTEXT_SHARE = 0.25;

/**
 * Bağlam bütçesinin ALT SINIRI. Sabit çekirdek (plan, görev, standartlar,
 * hedef dosyalar) bunun altına sığmaz; altına düşmek bağlamı sessizce
 * boşaltmak olur.
 */
export const MIN_CONTEXT_TOKENS = 2_000;

/** Görevin efektif token bütçesi; 0 "belirtilmedi" demektir. */
export function effectiveTaskBudget(
  taskBudget: number | undefined,
  role?: AgentRole | string | undefined,
): number {
  if (typeof taskBudget === 'number' && Number.isSafeInteger(taskBudget) && taskBudget > 0) {
    return taskBudget;
  }
  const byRole = role === undefined ? undefined : ROLE_DEFAULT_TASK_BUDGET[role];
  return byRole ?? FALLBACK_TASK_BUDGET;
}

/** Bağlam paketine ayrılan token bütçesi. */
export function contextTokenBudget(
  taskBudget: number | undefined,
  role?: AgentRole | string | undefined,
): number {
  const budget = effectiveTaskBudget(taskBudget, role);
  return Math.max(MIN_CONTEXT_TOKENS, Math.floor(budget * CONTEXT_SHARE));
}

/** Modele gösterilecek bütçe metni. Sıfır "sınırsız" DEĞİLDİR. */
export function describeTaskBudget(
  taskBudget: number | undefined,
  role?: AgentRole | string | undefined,
): string {
  const effective = effectiveTaskBudget(taskBudget, role);
  return taskBudget === undefined || taskBudget <= 0
    ? `${effective} (varsayılan)`
    : String(effective);
}
