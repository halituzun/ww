// Panelden açılan görevin plan kimliği.
//
// NEDEN VAR: görev oluşturma `plan_id: input.planId ?? NIL_UUID` yazıyordu.
// Atama ise plan kimliği ister ve NIL'i reddeder:
//   SchedulerError: task plan kimligi tasimiyor: <taskId>
// Sonuç: kullanıcı panelden görev açar, panel görevi "queued" gösterir, kuyruk
// onu her turda reddeder ve görev hiç çalışmaz — hem de projenin ONAYLI planı
// dururken. Sessiz başarısızlık, deponun tekrar eden en pahalı hatasıdır.
//
// Plan yoksa görev SESSİZCE açılmaz: açık hata, hiç koşmayan bir görevden iyidir.
import { NIL_UUID, type EntityId } from '@ww/shared';

export class TaskPlanError extends Error {}

export interface PlanCandidate {
  readonly plan_id: string;
  /** Aynı statüdeki planlar arasında en yenisi seçilir. */
  readonly version: string;
}

/** Boş ve NIL kimlik "verilmedi" demektir; ikisi de atamada reddedilir. */
export const isConcretePlanId = (value: string | undefined): value is string =>
  typeof value === 'string' && value !== '' && value !== NIL_UUID;

const isConcrete = isConcretePlanId;

/** Aynı statüdeki adaylardan en yüksek SÜRÜMLÜ olan. Sürüm UInt64 string'idir:
 * metinsel karşılaştırma "10" < "9" der, bu yüzden sayısal karşılaştırılır. */
function newest(candidates: readonly PlanCandidate[]): PlanCandidate | undefined {
  return candidates.reduce<PlanCandidate | undefined>((best, candidate) => {
    if (best === undefined) return candidate;
    return BigInt(candidate.version) > BigInt(best.version) ? candidate : best;
  }, undefined);
}

/**
 * Çağıran bir plan verdiyse o kullanılır. Aksi halde projenin onaylı planı,
 * o da yoksa önerilmiş planı seçilir. Hiçbiri yoksa hata atılır.
 */
export function resolveTaskPlanId(
  requestedPlanId: string | undefined,
  plans: Readonly<{ approved: readonly PlanCandidate[]; proposed: readonly PlanCandidate[] }>,
): EntityId {
  if (isConcrete(requestedPlanId)) return requestedPlanId as EntityId;
  const chosen = newest(plans.approved) ?? newest(plans.proposed);
  if (chosen === undefined) {
    throw new TaskPlanError(
      'proje icin plan bulunamadi: gorev plansiz acilirsa atanamaz ve hic calismaz',
    );
  }
  return chosen.plan_id as EntityId;
}
