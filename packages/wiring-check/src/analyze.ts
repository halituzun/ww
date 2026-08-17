/**
 * "Yazılmış ama hiç bağlanmamış kod" kapısı.
 *
 * Bu depoda tekrar eden en pahalı hata deseni şuydu: bir özellik yazılır,
 * testleri geçer, ama onu çağıran hiçbir üretim kodu olmaz. Sonuç sessizdir —
 * testler yeşil, /health yeşil, özellik yok. 2026-08-16/17 gecesinde bu desen
 * beş ayrı yerde bulundu: sağlayıcı sağlık kontrolü, role_models, dört güvenlik
 * freni, orkestrasyon runtime'ı ve tırmandırma zinciri.
 *
 * Kapı yeni ihlalleri engeller; mevcut olanlar temel listede (baseline)
 * bekletilir ve zamanla eritilir.
 */

export interface SourceFile {
  path: string;
  text: string;
}

export interface WiringReport {
  /** Testte kullanılıyor ama üretimde çağrılmıyor — aranan desen. */
  unwired: string[];
  /** Hiç kullanılmıyor — ayrı bir sorun (ölü kod), ayrı raporlanır. */
  untested: string[];
}

export interface BaselineDiff {
  added: string[];
  resolved: string[];
}

const EXPORT_PATTERN = /^export (?:async )?(?:function|class|const) ([A-Za-z_][A-Za-z0-9_]*)/gm;

const isTest = (path: string): boolean => /\.test\.tsx?$/.test(path);
// index.ts yalnız yeniden dışa açar; oradaki ad bir kullanım değildir.
const isBarrel = (path: string): boolean => /(^|\/)index\.ts$/.test(path);

function countOccurrences(text: string, name: string): number {
  const matches = text.match(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'));
  return matches === null ? 0 : matches.length;
}

export function analyzeWiring(files: readonly SourceFile[]): WiringReport {
  const exports = new Map<string, SourceFile>();
  for (const file of files) {
    if (isTest(file.path) || isBarrel(file.path)) continue;
    for (const match of file.text.matchAll(EXPORT_PATTERN)) {
      exports.set(`${file.path}:${match[1]!}`, file);
    }
  }

  const unwired: string[] = [];
  const untested: string[] = [];

  for (const [key, owner] of exports) {
    const name = key.slice(owner.path.length + 1);
    const own = countOccurrences(owner.text, name);

    let production = 0;
    let testing = 0;
    for (const file of files) {
      if (file.path === owner.path || isBarrel(file.path)) continue;
      const hits = countOccurrences(file.text, name);
      if (hits === 0) continue;
      if (isTest(file.path)) testing += hits;
      else production += hits;
    }

    if (production > 0) continue;                 // bağlı
    if (testing > 0) unwired.push(key);           // aranan desen
    else if (own > 0) untested.push(key);         // ölü kod
  }

  return { unwired: unwired.sort(), untested: untested.sort() };
}

export function diffAgainstBaseline(
  current: readonly string[],
  baseline: readonly string[],
): BaselineDiff {
  const known = new Set(baseline);
  const now = new Set(current);
  return {
    added: current.filter((entry) => !known.has(entry)).sort(),
    resolved: baseline.filter((entry) => !now.has(entry)).sort(),
  };
}
