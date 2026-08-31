// Projenin bağımlılıksız kapı denetimi (docs/05 → çalıştırma/test kapısı).
//
// NEDEN VAR: iskeletin varsayılan kapısı yalnızca "src altında kaynak dosya
// var ve boş değil" diyordu. Bu kapıdan neredeyse her şey geçer; canlı koşuda
// "uygulama kapıdan geçti" demek çok az şey ifade ediyordu.
//
// Sandbox'ta ağ yok, paket kurulamaz — yani `tsc`/lint çalıştırılamaz. Ama
// bağımlılıksız olarak da GERÇEK kusurlar yakalanabilir. Buradaki kontroller
// model üretimi kodda fiilen görülen bozulmaları hedefler:
//
// - Markdown çiti (```) kaynak dosyaya sızması: model cevabını kod bloğu
//   olarak yazınca dosya derlenemez hâle gelir ve bu sessizce commit'lenir.
// - Çakışma işaretleri: birleştirme artığı taşıyan dosya asla çalışmaz.
// - Bozuk JSON: package.json/tsconfig.json bozulursa proje kurulamaz.
//
// Betik PROJEYE yazılır (`ww.gate.check.cjs`) ve kapı adımı onu çalıştırır;
// böylece test edilen kod ile çalışan kod aynı kaynaktır.

export const GATE_CHECK_FILENAME = 'ww.gate.check.cjs';

export const GATE_CHECK_SCRIPT = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = /[.](ts|tsx|js|jsx|css|html)$/;
const problems = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true })
    .map(String)
    .filter((name) => fs.statSync(path.join(dir, name)).isFile());
}

const sources = walk('src').filter((name) => SOURCE.test(name));
if (sources.length === 0) problems.push('src altinda kaynak dosya yok');

for (const name of sources) {
  const file = path.join('src', name);
  const text = fs.readFileSync(file, 'utf8');
  if (text.trim() === '') { problems.push('bos dosya: ' + file); continue; }
  // Model cevabini kod blogu olarak yazinca dosya derlenemez hale gelir.
  if (/^\\s*\`\`\`/.test(text) || /\\n\`\`\`/.test(text)) {
    problems.push('kaynak dosyada markdown kod citi var: ' + file);
  }
  if (/^(<{7}|={7}|>{7})/m.test(text)) {
    problems.push('birlestirme catismasi isareti var: ' + file);
  }
}

for (const name of ['package.json', 'tsconfig.json', ...walk('src').filter((n) => n.endsWith('.json'))]) {
  const file = name.startsWith('src') || !fs.existsSync(name) ? path.join('src', name) : name;
  const target = fs.existsSync(name) ? name : file;
  if (!fs.existsSync(target)) continue;
  try { JSON.parse(fs.readFileSync(target, 'utf8')); }
  catch (error) { problems.push('bozuk JSON: ' + target + ' (' + error.message + ')'); }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log('kapi denetimi gecti: ' + sources.length + ' kaynak dosya');
`;
