// Emre iliştirilen aktif ekran bağlamı (docs/10 → Ortak Davranışlar).
//
// NEDEN VAR: `sendUserCommand` yalnız METİN taşıyordu. "Gördüğüm şu ekranda
// X'i değiştir" türü bir emir, hangi ekranın açık olduğu bilinmeden
// anlamsızdır: PM neyi değiştireceğini bilemez ve soru sormak zorunda kalır
// (her soru bir tur ve bir model çağrısı demektir).

export interface ScreenContextInput {
  readonly tab: string;
  readonly previewUrl?: string | undefined;
  readonly mobileSessionId?: string | undefined;
}

export function commandScreenContext(input: ScreenContextInput): string {
  const parts = [`Açık sekme: ${input.tab}`];
  // İkisi birden açıksa İKİSİ de bildirilir: PM hangisinden bahsedildiğini
  // ancak böyle sorabilir.
  if (input.previewUrl !== undefined && input.previewUrl !== '') {
    parts.push(`Web önizleme: ${input.previewUrl}`);
  }
  if (input.mobileSessionId !== undefined && input.mobileSessionId !== '') {
    parts.push(`Açık cihaz oturumu: ${input.mobileSessionId}`);
  }
  return parts.join('\n');
}

/**
 * Bağlam emirden AYRI bir blok olarak eklenir. Metne karıştırmak, PM'e
 * kullanıcının yazdığı sanılan bir cümle verirdi.
 */
export function withScreenContext(command: string, context: string): string {
  if (context.trim() === '') return command;
  return `${command}\n\n---\n[panel bağlamı]\n${context}`;
}
