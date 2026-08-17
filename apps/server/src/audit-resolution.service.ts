// Denetim bulgusunun kapatılması (docs/03 → ihlal, düzeltme görevine dönüşür).
//
// NEDEN VAR: bulgu kaydedilebiliyordu ama KAPATILAMIYORDU. Açılıp hiç
// kapanmayan bulgu listesi zamanla anlamını yitirir: "açık" sayısı gerçek
// borç değil, birikmiş gürültü olur.
import { z } from 'zod';
import { AUDIT_FINDING_STATUSES, EntityIdSchema } from '@ww/shared';

const ResolutionInput = z.strictObject({
  status: z.enum(AUDIT_FINDING_STATUSES),
  resolution: z.string().trim().min(1).max(4_000).optional(),
  correctiveTaskId: EntityIdSchema.optional(),
}).superRefine((value, ctx) => {
  // Şema: düzeltme bekleyen bulgu, düzeltme görevini göstermek ZORUNDA.
  if (value.status === 'correction_pending' && value.correctiveTaskId === undefined) {
    ctx.addIssue({ code: 'custom', path: ['correctiveTaskId'], message: 'correction_pending düzeltme görevi gerektirir' });
  }
  // Gerekçesiz kapatma, "neden kapandı" sorusunu cevapsız bırakır.
  if ((value.status === 'resolved' || value.status === 'dismissed') && value.resolution === undefined) {
    ctx.addIssue({ code: 'custom', path: ['resolution'], message: `${value.status} için gerekçe zorunludur` });
  }
});

export type ResolutionInputValue = z.infer<typeof ResolutionInput>;

export const parseResolutionInput = (value: unknown): ResolutionInputValue =>
  ResolutionInput.parse(value);

/** Mevcut bulgunun üzerine kararı uygular; kimlik ve kanıt korunur. */
export function applyResolution(
  current: Record<string, unknown>,
  input: ResolutionInputValue,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current, status: input.status };
  if (input.resolution !== undefined) next['resolution'] = input.resolution;
  if (input.correctiveTaskId !== undefined) next['correctiveTaskId'] = input.correctiveTaskId;
  return next;
}
