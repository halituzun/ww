// ww'nin KENDİ standardını KENDİ paneline uygular (docs/09).
//
// NEDEN VAR: `auditStandards` üretilen projeleri denetliyor ve commit sonrası
// tetikleniyordu — ama ww'nin kendi paneline yalnız biri ELLE koşturunca
// bakılıyordu. Yani sonraki oturum bir MVVM ihlali eklerse hiçbir şey
// yakalamazdı. Kendi standardını kendine uygulamayan bir denetçinin,
// ürettiği projelere kural koyması inandırıcı değildir.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { auditStandards } = await import(
  path.join(root, 'apps/server/dist/standards-audit.js')
);

/** Denetlenen alanlar: panelin tamamı. */
const SCOPES = ['apps/panel/src'];

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(full) : [full];
});

const findings = [];
for (const scope of SCOPES) {
  for (const file of walk(path.join(root, scope))) {
    // Testler kuralın konusu değildir: sahte bileşenler kasten kural dışıdır.
    if (file.includes('.test.')) continue;
    const relative = path.relative(root, file);
    findings.push(...auditStandards(relative, readFileSync(file, 'utf8')));
  }
}

if (findings.length === 0) {
  console.log(`[öz-denetim] ${SCOPES.join(', ')} temiz`);
  process.exit(0);
}

console.error(`[öz-denetim] ${findings.length} ihlal:`);
for (const finding of findings) {
  console.error(`  ${finding.ruleId} ${finding.filePath}`);
  console.error(`    ${finding.summary}`);
}
process.exit(1);
