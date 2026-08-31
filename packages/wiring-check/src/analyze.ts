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
  /**
   * Adı yaygın olduğu için DOĞRULANAMAYAN sınıf metotları.
   *
   * NEDEN VAR: metot bağlılığı `.ad(` deseniyle ölçülüyor. `get`, `run`,
   * `push`, `apply` gibi adlar `Map.get(`, `Array.push(`, `Object.assign(`
   * çağrılarıyla eşleşir; bu metotlar HER ZAMAN "bağlı" görünür ve asla
   * raporlanamaz. Denetçi bunu sessizce yutuyordu: yani sınıf metodu
   * yüzeyinin bir bölümü kalıcı olarak görünmezdi.
   *
   * Kapıyı DÜŞÜRMEZ (gerçekten bağlı olabilirler) ama sayılır ve yazılır:
   * ölçülemeyen şeyin ölçüldüğünü sanmak, ölçmemekten kötüdür.
   */
  unverifiable: string[];
}

export interface BaselineDiff {
  added: string[];
  resolved: string[];
}

/**
 * Temel liste girişi. Çıplak metin geriye uyumluluk içindir; yeni istisnalar
 * GEREKÇE taşımalıdır — gerekçesiz liste sessizce büyür ve kapı anlamını yitirir.
 */
export type BaselineEntry = string | { symbol: string; reason: string };

function baselineSymbols(baseline: readonly BaselineEntry[]): string[] {
  const out: string[] = [];
  for (const entry of baseline) {
    if (typeof entry === 'string') { out.push(entry); continue; }
    // Gerekçesiz nesne girişi yok sayılır: istisna bilinçli olmalıdır.
    if (typeof entry.reason === 'string' && entry.reason.trim().length > 0) out.push(entry.symbol);
  }
  return out;
}

const EXPORT_PATTERN = /^export (?:async )?(?:function|class|const) ([A-Za-z_][A-Za-z0-9_]*)/gm;

const isTest = (path: string): boolean => /\.test\.tsx?$/.test(path);
// index.ts yalnız yeniden dışa açar; oradaki ad bir kullanım değildir.
const isBarrel = (path: string): boolean => /(^|\/)index\.ts$/.test(path);

function countOccurrences(text: string, name: string): number {
  const matches = text.match(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'));
  return matches === null ? 0 : matches.length;
}


/**
 * Sınıf METOTLARI da bu kapının konusudur. `MemoryService.appendSummary` tam
 * bu kör noktadan saklandı: hiçbir çağıranı yoktu, kapı onu göremedi ve
 * görülmediği için gerçek tabloya hiç yazılmadığı (kolonları yanlış eşlediği)
 * da fark edilmedi.
 *
 * Üç yanlış-pozitif kaynağı bilinçli olarak elenir; gürültü kapıyı aşındırır:
 *  - ARAYÜZ üyeleri metot değildir (yalnız `export class` gövdesi taranır).
 *  - Nest CONTROLLER metotlarını framework yönlendirir, ad ile çağırmaz.
 *  - Yaşam döngüsü kancalarını (onModuleInit vb.) framework çağırır.
 */
// TEK SATIRLIK sınıf (`export class X extends Error {}`) ayrı yakalanır.
// Genel desen `^}` arayınca onu ATLAR ve bir SONRAKİ sınıfın gövdesini ona
// mal eder; rapor yanlış sınıf adı yazar (canlı örnek:
// `MobileSessionError.sessionOf` — o metot başka sınıfındı).
const CLASS_BODY = /^export (?:abstract )?class [^\n]*\{\}$|^export (?:abstract )?class [\s\S]*?^}/gm;
const CLASS_NAME = /^export (?:abstract )?class ([A-Za-z_][A-Za-z0-9_]*)/;
const METHOD_PATTERN = /^ {2}(?:public\s+|readonly\s+)?(?:async\s+)?([a-zA-Z_][A-Za-z0-9_]*)\s*\(/gm;

const FRAMEWORK_METHODS = new Set([
  'onModuleInit', 'onModuleDestroy', 'onApplicationBootstrap',
  'beforeApplicationShutdown', 'onApplicationShutdown', 'constructor',
  // WebSocket ağ geçidi kancalarını da FRAMEWORK çağırır, ad ile değil.
  'handleConnection', 'handleDisconnect', 'afterInit',
]);

const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function']);

/**
 * `.ad(` eşleşmesini güvenilmez kılan adlar: yerleşik nesnelerin ve yaygın
 * kütüphane API'lerinin metotları. Bu adları taşıyan bir sınıf metodu
 * `Map.get(`, `Array.push(`, `Promise.then(` gibi ALAKASIZ çağrılarla
 * eşleşir ve her zaman "bağlı" görünür.
 */
const AMBIGUOUS_METHOD_NAMES = new Set([
  'get', 'set', 'has', 'add', 'delete', 'clear', 'keys', 'values', 'entries',
  'push', 'pop', 'shift', 'slice', 'splice', 'join', 'map', 'filter', 'find',
  'includes', 'forEach', 'sort', 'reverse', 'concat', 'flat',
  'then', 'catch', 'finally', 'apply', 'call', 'bind', 'toString', 'valueOf',
  'run', 'start', 'stop', 'close', 'open', 'send', 'emit', 'on', 'off', 'once',
  'read', 'write', 'load', 'save', 'parse', 'test', 'exec', 'next', 'query',
  'insert', 'update', 'remove', 'connect', 'destroy', 'end', 'json', 'text',
]);

const isController = (file: SourceFile): boolean =>
  /\.controller\.tsx?$/.test(file.path) || /@Controller\(/.test(file.text);

interface ClassMethod { readonly key: string; readonly name: string; readonly owner: SourceFile; }

function classMethods(files: readonly SourceFile[]): ClassMethod[] {
  const found: ClassMethod[] = [];
  for (const file of files) {
    if (isTest(file.path) || isBarrel(file.path) || isController(file)) continue;
    for (const body of file.text.match(CLASS_BODY) ?? []) {
      const className = CLASS_NAME.exec(body)?.[1];
      if (className === undefined) continue;
      for (const match of body.matchAll(METHOD_PATTERN)) {
        const name = match[1]!;
        if (FRAMEWORK_METHODS.has(name) || CONTROL_KEYWORDS.has(name)) continue;
        found.push({ key: `${file.path}:${className}.${name}`, name, owner: file });
      }
    }
  }
  return found;
}

/**
 * `.metot(` çağrısı — polimorfik çağrılar da aynı adı kullanır.
 *
 * İSTEĞE BAĞLI ÇAĞRI da sayılır (`x?.metot?.(...)`): saymamak, gerçekten
 * bağlı bir metodu "ölü kod" diye raporlar ve listeye güven kalmaz.
 */
function countCalls(text: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (text.match(new RegExp(`\\.${escaped}\\s*\\??\\.?\\s*\\(`, 'g')) ?? []).length;
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
  const unverifiable: string[] = [];

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
    // Kendi dosyasında tanımının ötesinde kullanılıyorsa (own > 1) o modülün
    // mantığı tarafından tüketiliyor demektir: eşik/sabit gibi. Aranan desen
    // "hiç çağrılmayan özellik"tir ve onun kendi dosyasındaki sayısı 1'dir.
    if (own > 1) continue;
    if (testing > 0) unwired.push(key);           // aranan desen
    else if (own > 0) untested.push(key);         // ölü kod
  }

  for (const method of classMethods(files)) {
    // ADI YAYGIN OLAN METOT ÖLÇÜLEMEZ. Sessizce "bağlı" saymak yerine
    // ayrı sayılır: kör noktanın kendisi rapora girer.
    if (AMBIGUOUS_METHOD_NAMES.has(method.name)) {
      unverifiable.push(method.key);
      continue;
    }
    let production = 0;
    let testing = 0;
    for (const file of files) {
      // AYNI DOSYA da sayılır: aynı dosyadaki başka bir sınıfın çağırması
      // gerçek bir bağlantıdır. Tanım satırı zaten `.ad(` desenine uymaz
      // (nokta yoktur), o yüzden ayrıca elemek gerekmez.
      const hits = countCalls(file.text, method.name);
      if (hits === 0) continue;
      if (isTest(file.path)) testing += hits;
      else production += hits;
    }
    if (production > 0) continue;
    // HİÇ kullanılmayan metot da raporlanır. Eskiden yalnız "testte var,
    // üretimde yok" durumu görülüyordu; hiç dokunulmamış metot sessizce
    // geçiyordu. Canlı örnek: `AgentCloneService.stopIdleClones` — ne üretim
    // ne test çağırıyordu ve docs/03'ün klon süpürme kuralı hiç koşmadı.
    if (testing > 0) unwired.push(method.key);
    else untested.push(method.key);
  }

  return {
    unwired: unwired.sort(),
    untested: untested.sort(),
    unverifiable: unverifiable.sort(),
  };
}

export function diffAgainstBaseline(
  current: readonly string[],
  baseline: readonly BaselineEntry[],
  /**
   * Hâlâ ÖLÜ olan semboller. Bunlar `current` (bağlantısız) listesinde
   * olmadıkları için "bağlandı" görünüyorlardı — oysa bağlanmamışlardı,
   * yalnızca başka listedeydiler. Yanlış bir "çözüldü" raporu, kaydı silmeye
   * davet eder ve boşluk gizlenir.
   */
  stillDead: readonly string[] = [],
): BaselineDiff {
  const symbols = baselineSymbols(baseline);
  const known = new Set(symbols);
  const now = new Set(current);
  const dead = new Set(stillDead);
  return {
    added: current.filter((entry) => !known.has(entry)).sort(),
    resolved: symbols.filter((entry) => !now.has(entry) && !dead.has(entry)).sort(),
  };
}

/**
 * Temel listede GEREKÇESİYLE yer almayan ölü kod.
 *
 * NEDEN VAR: ölü kod listesi her koşuda basılıyordu ve bilinen/bilinçli
 * girişler orada kalıyordu. Sonuç: her oturum aynı iki metodu yeniden
 * araştırıyor ve liste gürültüye dönüşüyor. Gürültülü liste okunmaz, okunmayan
 * liste de kapı değildir.
 *
 * Gerekçesiz giriş DÜŞMEZ — istisna bilinçli olmalıdır (bağlantısız listesiyle
 * aynı kural).
 */
export function unbaselinedDeadCode(
  report: Pick<WiringReport, 'untested'>,
  baseline: readonly BaselineEntry[],
): string[] {
  const known = new Set(baselineSymbols(baseline));
  return report.untested.filter((symbol) => !known.has(symbol));
}
