// Rol → model zincirinin panelde GÖSTERİLEN hâli.
//
// NEDEN VAR: uç, `effectiveChain` alanında `routing.fallbacks(modelRef)`
// döndürüyordu. Ama `fallbacks` tasarımı gereği BİRİNCİL modeli dışlar
// ("kendisi yedeği olamaz"). Sonuç: yapılandırılmış bir rolde zincir BOŞ
// görünüyor ve kullanıcı "bu rol için hiçbir model çalışmayacak" diye okuyor —
// oysa birincil model çalışacaktır. Alan adı ve yorumu "fiilen kullanılacak
// zincir" diyorsa, birincil de içinde olmalıdır.
export function effectiveRoutingChain(
  modelRef: string,
  fallbacks: readonly string[],
): readonly string[] {
  if (modelRef.trim() === '') return Object.freeze([]);
  const chain = [modelRef];
  for (const ref of fallbacks) {
    // Yinelenen kayıt, zinciri olduğundan uzun gösterir.
    if (!chain.includes(ref)) chain.push(ref);
  }
  return Object.freeze(chain);
}
