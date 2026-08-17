// Orkestrasyon runtime'ının bağlam çözümü (docs/03 → roller, docs/04 → model eşleme).
//
// `Phase1RuntimeContextPort` göreve mühürlü prompt girdisi + workspace yolu +
// model referansları verir. Bu modül ikinci ve üçüncü parçayı sağlar; mühürlü
// prompt girdisi ayrı bir adımdır.
import { isAbsolute, join } from 'node:path';
import type { RoutingIndex } from '@ww/providers';

export interface RuntimeModels {
  workerModelRef: string;
  verifierModelRef: string;
  /** docs/04 çapraz kontrol kuralı ihlal edildiyse; engelleyici değildir. */
  warning?: string;
}

const providerOf = (modelRef: string): string => modelRef.split(':')[0] ?? '';

/**
 * Rol eşlemesi yoksa varsayılana DÜŞMEZ: kullanıcının seçmediği bir modelle
 * para harcamak sessiz bir hatadır. Fail-closed davranış doğrusudur.
 */
export function resolveRuntimeModels(routing: RoutingIndex): RuntimeModels {
  const workerModelRef = routing.modelForRole('worker');
  if (workerModelRef === undefined || workerModelRef === '') {
    throw new Error("worker rolü için model eşlemesi yok — panelden 'Rol → model' tablosunu doldurun");
  }
  const verifierModelRef = routing.modelForRole('verifier');
  if (verifierModelRef === undefined || verifierModelRef === '') {
    throw new Error("verifier rolü için model eşlemesi yok — panelden 'Rol → model' tablosunu doldurun");
  }

  // docs/04: verifier worker'dan FARKLI sağlayıcıdan olmalı; çapraz kontrol
  // önyargıyı kırar. Aynı sağlayıcı seçilmişse denetimin değeri düşer.
  const warning = providerOf(workerModelRef) === providerOf(verifierModelRef)
    ? `verifier worker ile aynı sağlayıcıda (${providerOf(workerModelRef)}) — çapraz kontrol zayıflar`
    : undefined;

  return warning === undefined
    ? { workerModelRef, verifierModelRef }
    : { workerModelRef, verifierModelRef, warning };
}

// Sandbox sınırı yol düzeyinde başlar: proje kendi klasörünün dışına çıkamaz.
const SAFE_SLUG = /^[a-z0-9][a-z0-9_-]*$/i;

export function resolveWorkspaceRoot(workspaceRoot: string, slug: string): string {
  if (!isAbsolute(workspaceRoot)) throw new Error('workspace kökü mutlak yol olmalıdır');
  if (!SAFE_SLUG.test(slug)) {
    throw new Error(`geçersiz proje slug'ı: '${slug}' — yalnız harf, rakam, tire ve alt çizgi`);
  }
  return join(workspaceRoot, slug);
}
