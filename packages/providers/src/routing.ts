// Rol -> model yönlendirmesi ve fallback zinciri (docs/04 → Rol→Model Eşleme,
// Fallback).
//
// role_models tablosu tur 3'te hayata geçti ama yalnız kendi REST controller'ı
// kullanıyordu: yönlendirmeye bağlı değildi. ModelRouter ise `fallbacks(modelRef)`
// bekliyor. Bu modül ikisini birleştirir.

export interface RoleModelEntry {
  role: string;
  modelRef: string;
  fallbackRefs: readonly string[];
}

export interface RoutingProvider {
  providerId: string;
  enabled: boolean;
  isDefault: boolean;
  models: readonly string[];
}

export interface RoutingIndex {
  modelForRole: (role: string) => string | undefined;
  /** ModelRouter'ın beklediği senkron imza. */
  fallbacks: (modelRef: string) => string[];
}

const MODEL_REF = /^[a-z0-9_-]+:[A-Za-z0-9._:-]+$/;
const providerOf = (modelRef: string): string => modelRef.split(':')[0] ?? '';

export function buildRoutingIndex(
  roleModels: readonly RoleModelEntry[],
  providers: readonly RoutingProvider[],
): RoutingIndex {
  const usable = new Set(
    providers.filter((provider) => provider.enabled).map((provider) => provider.providerId),
  );

  // Pasif veya kayıtsız sağlayıcıya düşmek sessizce hataya koşmaktır.
  const isUsable = (modelRef: string): boolean =>
    MODEL_REF.test(modelRef) && usable.has(providerOf(modelRef));

  const byRole = new Map<string, string>();
  for (const entry of roleModels) {
    if (!MODEL_REF.test(entry.modelRef)) continue;
    byRole.set(entry.role, entry.modelRef);
  }

  // docs/04: zincirin son durağı varsayılan sağlayıcının ilk modelidir.
  const fallbackProvider = providers.find((provider) => provider.isDefault && provider.enabled);
  const lastResort = fallbackProvider && fallbackProvider.models[0] !== undefined
    ? `${fallbackProvider.providerId}:${fallbackProvider.models[0]}`
    : undefined;

  // Aynı modele eşlenen birden çok rolün yedekleri birleşir, sıra korunur.
  const chains = new Map<string, string[]>();
  for (const entry of roleModels) {
    if (!MODEL_REF.test(entry.modelRef)) continue;
    const chain = chains.get(entry.modelRef) ?? [];
    for (const ref of entry.fallbackRefs) {
      if (ref === entry.modelRef) continue;      // kendisi yedeği olamaz
      if (!isUsable(ref)) continue;
      if (!chain.includes(ref)) chain.push(ref);
    }
    chains.set(entry.modelRef, chain);
  }

  return {
    modelForRole: (role) => byRole.get(role),
    fallbacks: (modelRef) => {
      const chain = [...(chains.get(modelRef) ?? [])];
      if (lastResort !== undefined && lastResort !== modelRef && !chain.includes(lastResort)) {
        chain.push(lastResort);
      }
      return chain;
    },
  };
}
