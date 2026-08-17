#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { analyzeWiring, diffAgainstBaseline, type SourceFile } from './analyze.js';

const ROOT = process.cwd();
const SCAN_DIRS = ['packages', 'apps'];
const BASELINE = join(ROOT, 'wiring-baseline.json');

async function collect(dir: string, out: SourceFile[]): Promise<void> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.turbo', 'templates'].includes(entry.name)) continue;
      await collect(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push({ path: relative(ROOT, full), text: await readFile(full, 'utf8') });
    }
  }
}

const files: SourceFile[] = [];
for (const dir of SCAN_DIRS) await collect(join(ROOT, dir), files);

const report = analyzeWiring(files);
let baseline: string[] = [];
try { baseline = JSON.parse(await readFile(BASELINE, 'utf8')) as string[]; } catch { /* ilk koşu */ }

const diff = diffAgainstBaseline(report.unwired, baseline);

console.log(`taranan dosya: ${files.length}`);
console.log(`bağlantısız (testte var, üretimde yok): ${report.unwired.length}`);
console.log(`hiç kullanılmayan: ${report.untested.length}`);

if (diff.resolved.length > 0) {
  console.log(`\n✓ bağlandı (${diff.resolved.length}) — wiring-baseline.json'dan düşürülebilir:`);
  for (const entry of diff.resolved) console.log(`    ${entry}`);
}

if (diff.added.length > 0) {
  console.error(`\n✗ YENİ bağlantısız kod (${diff.added.length}):`);
  for (const entry of diff.added) console.error(`    ${entry}`);
  console.error('\nBu semboller testte kullanılıyor ama hiçbir üretim kodu çağırmıyor.');
  console.error('Ya bağlayın ya da bilinçli bir karara dayanıyorsa wiring-baseline.json\'a ekleyin.');
  process.exit(1);
}

console.log('\n✓ yeni bağlantısız kod yok');
