// Panel dosya görüntüleyicinin yol sınırı.
//
// NEDEN VAR: docs/08 dosya gezgininde GERÇEK içerik ister; görüntüleyici ise
// yer tutucu metin gösteriyordu. İçeriği sunmak için dosya okumak gerekir ve
// burada tek kritik kural şudur: istenen yol PROJE workspace'inin dışına
// çıkamaz. Sınır olmadan bir uç, sunucudaki her dosyayı okutur.
import path from 'node:path';

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

export function resolveWorkspaceFile(workspaceRoot: string, relativePath: string): string {
  if (!path.isAbsolute(workspaceRoot)) {
    throw new WorkspacePathError('workspace kökü mutlak olmalıdır');
  }
  if (relativePath.trim() === '') {
    throw new WorkspacePathError('dosya yolu boş olamaz');
  }
  // Mutlak yol ya da sürücü kökü doğrudan reddedilir.
  if (path.isAbsolute(relativePath)) {
    throw new WorkspacePathError('dosya yolu göreli olmalıdır');
  }
  if (relativePath.includes('\0')) {
    throw new WorkspacePathError('dosya yolu geçersiz karakter içeriyor');
  }

  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, relativePath);
  const contained = target === root || target.startsWith(`${root}${path.sep}`);
  if (!contained) {
    // `..` ile dışarı çıkma denemesi: sessizce kırpmak yerine reddedilir.
    throw new WorkspacePathError('dosya yolu workspace dışına çıkamaz');
  }
  return target;
}
