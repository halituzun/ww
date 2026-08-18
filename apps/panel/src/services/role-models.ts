// Rol -> model eşlemesi IO katmanı (docs/04 → Rol→Model Eşleme, docs/08 → API Yönetimi).
import { getJson, requestJson, type RequestOptions } from './http.js';

export interface RoleModel {
  role: string;
  modelRef: string;
  fallbackRefs: string[];
  /** Sunucunun fiilen kuracağı zincir: pasif/kayıtsız sağlayıcılar elenmiş. */
  effectiveChain?: string[];
  configured: boolean;
  updatedAt: string;
}

// Sunucu tarafındaki kuralın aynısı; hatalı biçim ağa çıkmadan yakalanır.
const MODEL_REF = /^[a-z0-9_-]+:[A-Za-z0-9._-]+$/;

function assertModelRef(value: string): string {
  const ref = value.trim();
  if (!MODEL_REF.test(ref)) {
    throw new Error(`'${value}' geçersiz — model referansı provider:model biçiminde olmalı (ör. deepseek:deepseek-chat)`);
  }
  return ref;
}

export const fetchRoleModels = (options: RequestOptions = {}): Promise<RoleModel[]> =>
  // HATAYI YUTMAZ: boş dizi TABLOYU BOŞ gösterir ve bu "hiç rol eşlemesi
  // yok" gibi okunur. Kullanıcı var olan eşlemeleri yeniden kurmaya
  // yönelir; docs/04 varsayılana düşmenin parayla sonuçlandığını söylüyor
  // ("kullanıcının seçmediği modelle para harcamak").
  getJson<RoleModel[]>('/role-models', options);

export async function saveRoleModel(
  role: string,
  modelRef: string,
  fallbackRefs: string[],
  options: RequestOptions = {},
): Promise<RoleModel> {
  const body = {
    modelRef: assertModelRef(modelRef),
    fallbackRefs: fallbackRefs.map(assertModelRef),
  };
  return requestJson<RoleModel>(`/role-models/${encodeURIComponent(role)}`,
    { ...options, method: 'PATCH', body }, 'Rol eşlemesi kaydedilemedi');
}

const providerOf = (modelRef: string): string => modelRef.split(':')[0] ?? '';

/**
 * Belgelenmiş model-çeşitliliği kurallarını panelde görünür kılar.
 *
 * docs/04: verifier worker'dan FARKLI sağlayıcıdan seçilmelidir — çapraz kontrol
 * önyargıyı kırar. Konsey üyeleri için hedef en az 3 farklı sağlayıcıdır.
 * Bunlar engelleyici değil uyarıdır; kullanıcı bilerek aksini seçebilir.
 */
export function crossCheckWarnings(rows: readonly RoleModel[]): string[] {
  const configured = rows.filter((row) => row.configured && row.modelRef.trim().length > 0);
  const byRole = new Map(configured.map((row) => [row.role, row]));
  const warnings: string[] = [];

  const worker = byRole.get('worker');
  const verifier = byRole.get('verifier');
  if (worker && verifier && providerOf(worker.modelRef) === providerOf(verifier.modelRef)) {
    warnings.push(
      `verifier ile worker aynı sağlayıcıda (${providerOf(worker.modelRef)}) — çapraz kontrol için farklı sağlayıcı önerilir.`,
    );
  }

  // Yazılan yedek fiilen kullanılmıyorsa sessizce kaybolur: sağlayıcı kayıtlı
  // değil ya da pasif demektir. Bu, fallback'in hiç devreye girmemesi demek.
  for (const row of configured) {
    if (row.effectiveChain === undefined) continue;
    const dropped = row.fallbackRefs.filter((ref) => !row.effectiveChain!.includes(ref));
    if (dropped.length > 0) {
      warnings.push(
        `${row.role} için yazılan yedek fiilen kullanılmıyor (${dropped.join(', ')}) — sağlayıcı kayıtlı değil veya pasif.`,
      );
    }
  }

  const council = configured.filter((row) => row.role === 'council_member');
  if (council.length > 0) {
    const providers = new Set(council.map((row) => providerOf(row.modelRef)));
    if (providers.size < 3) {
      warnings.push(
        `konsey ${providers.size} farklı sağlayıcı kullanıyor — hedef en az 3; tartışmanın değeri çeşitlilikten gelir.`,
      );
    }
  }

  return warnings;
}
