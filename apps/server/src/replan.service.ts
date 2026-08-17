// Yeniden planlama girdisi (docs/03 → PM yeniden planlama turu açar).
//
// NEDEN VAR: `ReplanningService` yazılmıştı ama çağıran yoktu; plan bir kez
// oluşturulduktan sonra ürün üzerinden revize edilemiyordu.
import { z } from 'zod';

const ReplanInput = z.strictObject({
  // Sebepsiz revizyon, planın NEDEN değiştiğini kaydın dışında bırakır.
  reason: z.string().trim().min(1).max(2_000),
  summary: z.string().trim().min(1).max(20_000),
});

export type ReplanInputValue = z.infer<typeof ReplanInput>;

export const parseReplanInput = (value: unknown): ReplanInputValue => ReplanInput.parse(value);
