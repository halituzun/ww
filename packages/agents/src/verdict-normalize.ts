// Verifier verdiktinin şema öncesi normalleştirilmesi.
//
// NEDEN VAR: model kanıt listelerine boş dize koyabiliyor
// (`evidenceRefs: [""]`) ve şema boş dize kabul etmez; tüm doğrulama adımı
// ZodError ile düşüyordu — yani verifier onaylasa bile iş ilerleyemiyordu.
// Boş girdiyi ayıklamak model çıktısını DÜZELTMEK değil, taşıdığı bilgiyi
// bozmadan şemaya uydurmaktır: boş dize zaten kanıt taşımaz.
export function normalizeVerdictArguments(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value
      .filter((item) => !(typeof item === 'string' && item.trim() === ''))
      .map((item) => normalizeVerdictArguments(item));
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = normalizeVerdictArguments(entry);
  }
  return output;
}
