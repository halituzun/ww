// Prompt sürüm yönetimi girdisi (docs/03 → şablonlar DB'de, sürümlü ve
// panelden düzenlenebilir).
//
// NEDEN VAR: prompt tablosu ve sürüm işlevleri vardı ama HİÇBİR uç yoktu:
// promptlar ne listelenebiliyor ne yeni sürüm eklenebiliyor ne de aktif
// sürüm değiştirilebiliyordu. Görev brief'i prompt sürümünü mühürlediği için
// bu, "hangi talimatla çalışıyoruz" sorusunu ürün üzerinden cevapsız bırakır.
import { z } from 'zod';

const NewVersionInput = z.strictObject({
  content: z.string().trim().min(1).max(200_000),
  changelog: z.string().trim().min(1).max(2_000),
  variables: z.array(z.string().trim().min(1)).default([]),
  // Yeni sürüm varsayılan olarak AKTİF DEĞİLDİR: yazar yazmakla canlıya
  // almayı ayırmalı, yoksa bir düzenleme koşan işleri anında etkiler.
  activate: z.boolean().default(false),
});

export type NewVersionInputValue = z.infer<typeof NewVersionInput>;

export const parseNewVersionInput = (value: unknown): NewVersionInputValue =>
  NewVersionInput.parse(value);

/** Bir sonraki sürüm numarası: mevcutların en büyüğü + 1. */
export function nextPromptVersion(existing: readonly { prompt_version: number }[]): number {
  return existing.reduce((max, row) => Math.max(max, row.prompt_version), 0) + 1;
}
