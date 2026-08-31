// docs/09 Kapsam koruması — Scope Drift Guard.
//
// NEDEN VAR: Agent'lar onaylanmış planın dışına çıkıp rastgele veya
// gereksiz dosyalar yaratabiliyor, ya da workspace dışına (.env, .git)
// yazmaya kalkabiliyordu. Bu guard, her görevin yalnızca kendi planında
// tanımlı hedef dosyalar üzerinde işlem yapmasını garanti eder.


const FORBIDDEN_PREFIXES = ['.git/', '.env', 'node_modules/', '../', '/'];

export interface ScopeValidationResult {
  readonly allowed: boolean;
  readonly path: string;
  readonly reason?: string;
}

/** Dosya yolunun workspace içinde ve güvenli olduğunu doğrular */
export function isPathSafe(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').trim();
  if (normalized === '' || normalized.startsWith('/')) return false;
  for (const forbidden of FORBIDDEN_PREFIXES) {
    if (normalized.startsWith(forbidden) || normalized.includes('/../')) {
      return false;
    }
  }
  return true;
}

/** Görevin yazabileceği hedef dosyaları plana göre denetler */
export function validateTaskScope(
  filePath: string,
  allowedTargets: readonly string[] = [],
): ScopeValidationResult {
  if (!isPathSafe(filePath)) {
    return {
      allowed: false,
      path: filePath,
      reason: 'Güvensiz veya workspace dışı dosya yolu',
    };
  }

  // Eğer açıkça izin verilen bir hedef listesi tanımlanmışsa, dosya orada olmalı
  if (allowedTargets.length > 0) {
    const normalized = filePath.replace(/\\/g, '/');
    const isExplicitlyAllowed = allowedTargets.some(
      (t) => t.replace(/\\/g, '/') === normalized || normalized.startsWith(t.replace(/\\/g, '/') + '/')
    );
    if (!isExplicitlyAllowed) {
      return {
        allowed: false,
        path: filePath,
        reason: `Plan kapsamı dışı dosya: '${filePath}' izin verilen hedefler arasında değil (${allowedTargets.join(', ')})`,
      };
    }
  }

  return { allowed: true, path: filePath };
}
