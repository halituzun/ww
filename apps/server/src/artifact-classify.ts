// Commit edilen dosyanın artifact türü ve MVVM katmanı (docs/02, docs/09).
//
// NEDEN VAR: commit yolu `artifactIds: []` sabitliyordu ve dosya fihristi hiç
// güncellenmiyordu. Sonuç: `artifacts` tablosu 0 satır, panelin fihristi
// kalıcı olarak boş — "agent ne üretti" ve "bu dosyayı kim, neden değiştirdi"
// sorularının cevabı hiç kaydedilmiyordu (docs/08'in fihrist vaadi).
export type ArtifactKind =
  | 'controller' | 'service' | 'repository' | 'model' | 'view' | 'viewmodel'
  | 'component' | 'schema' | 'api_endpoint' | 'design_decision' | 'test'
  | 'config' | 'doc';

export function classifyArtifact(filePath: string): ArtifactKind {
  const path = filePath.toLowerCase();
  // Test önce gelir: 'src/view/a.test.tsx' bir görünüm değil testtir.
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return 'test';
  if (/\.(md|mdx)$/.test(path)) return 'doc';
  if (/\.(json|ya?ml|toml|ini|env)$/.test(path)) return 'config';
  if (path.includes('viewmodel') || /use[a-z0-9]+\.[cm]?ts$/.test(path)) return 'viewmodel';
  if (path.includes('controller')) return 'controller';
  if (path.includes('repositor')) return 'repository';
  if (path.includes('service')) return 'service';
  if (path.includes('schema')) return 'schema';
  if (/\.(tsx|jsx)$/.test(path)) return 'component';
  return 'model';
}

/** docs/09 MVVM katmanı; bilinmiyorsa uydurma yapılmaz. */
export function classifyLayer(filePath: string): string {
  const kind = classifyArtifact(filePath);
  if (kind === 'test') return 'test';
  if (kind === 'viewmodel') return 'viewmodel';
  if (kind === 'component' || kind === 'view') return 'view';
  if (kind === 'service' || kind === 'repository' || kind === 'controller') return 'model';
  return 'other';
}
