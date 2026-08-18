// `projects.workspace_path` — projenin çalışma alanı yolu.
//
// NEDEN VAR: kayıt `workspace/<projectId>` yazıyordu ama çalışma zamanı kökü
// SLUG ile çözüyor (`resolveWorkspaceRoot(root, slug)`). Yani kayıtlı yol her
// projede VAR OLMAYAN bir klasörü gösteriyordu: diskte 22 slug klasörü var,
// veritabanında 27 uuid yolu yazılı ve hiçbiri eşleşmiyor.
//
// Bugün bu kolonu okuyan bir üretim yolu YOK; ama yanlış bir kayıt, onu ilk
// okuyanı yanıltır ve "veri doğru, yüzey yalan söylüyor" sınıfının tohumudur.
import { SAFE_SLUG } from './runtime-context.js';

export const WORKSPACE_DIRECTORY = 'workspace';

export function projectWorkspacePath(slug: string): string {
  // Doğrulama çalışma zamanındakiyle AYNI olmalı; ayrışırsa kayıt yine
  // gerçeği yansıtmaz.
  if (!SAFE_SLUG.test(slug)) {
    throw new Error(`geçersiz proje slug'ı: '${slug}' — yalnız harf, rakam, tire ve alt çizgi`);
  }
  return `${WORKSPACE_DIRECTORY}/${slug}`;
}
