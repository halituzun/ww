#!/usr/bin/env node
// docs/DURUM.md içindeki ÖLÇÜLEN alanları üretir.
//
// NEDEN VAR: bu depoda "güncel durum" üç ayrı yerde elle tutuluyordu
// (CLAUDE.md, docs/11 Durum Özeti, docs/12 Mevcut Devir Noktası) ve üçü de
// birbirinden ve gerçeklikten saptı — 2026-08-31 ölçümünde docs/12 on gün,
// docs/11 on üç gün bayattı ve en güncel kayıt (memory/*.md) Git'te bile
// değildi. docs/12 bu tuzağı bizzat yazıyor: "Güncellenmezse sonraki ajan
// yanlış yerden başlar."
//
// Elle yazılan hiçbir sayı güncel kalmaz; bu yüzden sayılar ÜRETİLİR.
//
// Kullanım:
//   node scripts/durum.mjs            # docs/DURUM.md'deki bloğu yeniler
//   node scripts/durum.mjs --check    # blok bayatsa çıkış kodu 1
//
// Dal konumu ve commit sayısı BİLEREK ölçülmez: her commit'te değişir ve
// kapıyı sürekli kırmızıya düşürürdü. Onları okuyan `git status -sb` zaten
// her oturumun ilk adımıdır (AGENTS.md).

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'docs', 'DURUM.md');
const BEGIN = '<!-- ÜRETİLEN:BAŞLANGIÇ — elle düzenlemeyin, `node scripts/durum.mjs` çalıştırın -->';
const END = '<!-- ÜRETİLEN:SON -->';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.turbo', 'coverage', 'workspace']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
    } else {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const isTest = (path) => /\.(test|integration\.test|live\.test)\.tsx?$/.test(path);
const isSource = (path) => /\.tsx?$/.test(path) && !path.endsWith('.d.ts') && !isTest(path);

function measure() {
  const roots = [join(ROOT, 'apps'), join(ROOT, 'packages')];
  const files = roots.flatMap((dir) => walk(dir));

  const testFiles = files.filter(isTest);
  const sourceFiles = files.filter(isSource);

  let cases = 0;
  for (const file of testFiles) {
    cases += (readFileSync(file, 'utf8').match(/\bit\(/g) ?? []).length;
  }

  let sourceLines = 0;
  for (const file of sourceFiles) {
    sourceLines += readFileSync(file, 'utf8').split('\n').length;
  }

  // Colocation'a göre testsiz kaynak dosyalar. Vekil bir ölçüdür (testi
  // farklı adla duran dosyalar da sayılır) ama yönü doğru gösterir.
  const testNames = new Set(testFiles.map((f) => f.replace(/\.(test|integration\.test|live\.test)\.tsx?$/, '')));
  const untested = sourceFiles.filter((f) => !testNames.has(f.replace(/\.tsx?$/, '')));

  const baseline = JSON.parse(readFileSync(join(ROOT, 'wiring-baseline.json'), 'utf8'));
  const migrations = readdirSync(join(ROOT, 'packages', 'db', 'migrations')).filter((n) => n.endsWith('.sql'));

  const packages = readdirSync(join(ROOT, 'packages')).filter((n) =>
    statSync(join(ROOT, 'packages', n)).isDirectory(),
  ).length;
  const apps = readdirSync(join(ROOT, 'apps')).filter((n) =>
    statSync(join(ROOT, 'apps', n)).isDirectory(),
  ).length;

  const skipIfFiles = testFiles.filter((f) => readFileSync(f, 'utf8').includes('skipIf')).length;

  return {
    'Paket sayısı': `${packages} paket + ${apps} uygulama`,
    'Üretim kaynağı': `${sourceFiles.length} dosya, ${sourceLines.toLocaleString('tr-TR')} satır`,
    'Test dosyası': String(testFiles.length),
    'Test durumu (`it(` sayımı)': String(cases),
    'Servis gerektirdiği için atlanabilen test dosyası': `${skipIfFiles} (\`skipIf\`)`,
    'Colocation ile testsiz kaynak dosya': `${untested.length} / ${sourceFiles.length}`,
    'ClickHouse migration': String(migrations.length),
    'wiring-baseline girdisi': String(baseline.length),
  };
}

function renderBlock(values) {
  const rows = Object.entries(values)
    .map(([key, value]) => `| ${key} | ${value} |`)
    .join('\n');
  return `${BEGIN}\n\n| Ölçüm | Değer |\n|---|---|\n${rows}\n\n${END}`;
}

function main() {
  const check = process.argv.includes('--check');
  const block = renderBlock(measure());
  const current = readFileSync(TARGET, 'utf8');

  const start = current.indexOf(BEGIN);
  const stop = current.indexOf(END);
  if (start === -1 || stop === -1) {
    console.error(`[durum] ${TARGET} içinde ÜRETİLEN blok işaretleri bulunamadı`);
    process.exit(1);
  }

  const next = current.slice(0, start) + block + current.slice(stop + END.length);
  if (next === current) {
    console.log('[durum] docs/DURUM.md güncel');
    return;
  }

  if (check) {
    console.error('[durum] docs/DURUM.md BAYAT. `node scripts/durum.mjs` çalıştırıp commit edin.');
    process.exit(1);
  }

  writeFileSync(TARGET, next);
  console.log('[durum] docs/DURUM.md yenilendi');
}

main();
