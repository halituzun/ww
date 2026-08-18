// docs/09 standart denetçisi — MVVM (React).
//
// NEDEN VAR: `StandardsAuditor` yalnızca bulguyu KAYDEDEN bir sınıftı; hiçbir
// üretim yolu onu çağırmıyordu ve bulguyu ÜRETEN bir denetçi hiç yoktu.
// docs/11 Faz 4'ün kabul senaryosu "denetçiler en az bir bulgu üretip
// düzelttirir" diyor; bu adım bugüne kadar hiç koşamadı.
//
// Kural (docs/09): View katmanında `fetch`/iş mantığı YASAKTIR — veri erişimi
// ve durum ViewModel'e aittir. Denetim deterministiktir: modele sorulmaz,
// çünkü standart ihlali fikir değil olgudur.

export interface StandardsViolation {
  /**
   * STD-001 görünüm katmanı (fetch / durum), STD-002 ViewModel'in DOM'a
   * dokunması, STD-003 servisin UI framework'ü import etmesi.
   */
  readonly ruleId: 'STD-001' | 'STD-002' | 'STD-003';
  readonly filePath: string;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly severity: 'high' | 'medium';
}

/** View katmanı sayılan yollar: bileşenler ve sayfalar. */
const VIEW_PATH = /(^|\/)(components|views|pages)\//;
const VIEW_FILE = /\.(tsx|jsx)$/;

/** Yorum ve metin satırları ihlal değildir; kural kodu hedefler. */
function codeLines(content: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let inBlockComment = false;
  content.split('\n').forEach((raw, index) => {
    let text = raw;
    if (inBlockComment) {
      const end = text.indexOf('*/');
      if (end === -1) return;
      text = text.slice(end + 2);
      inBlockComment = false;
    }
    const blockStart = text.indexOf('/*');
    if (blockStart !== -1 && text.indexOf('*/', blockStart) === -1) {
      inBlockComment = true;
      text = text.slice(0, blockStart);
    }
    const lineComment = text.indexOf('//');
    if (lineComment !== -1) text = text.slice(0, lineComment);
    if (text.trim() !== '') out.push({ line: index + 1, text });
  });
  return out;
}

const VIEWMODEL_PATH = /(^|\/)viewmodels\//;
const SERVICE_PATH = /(^|\/)services\//;
const SCRIPT_FILE = /\.(ts|tsx|js|jsx)$/;

export function isViewFile(filePath: string): boolean {
  return VIEW_FILE.test(filePath) && VIEW_PATH.test(filePath);
}

export function isViewModelFile(filePath: string): boolean {
  return SCRIPT_FILE.test(filePath) && VIEWMODEL_PATH.test(filePath);
}

export function isServiceFile(filePath: string): boolean {
  return SCRIPT_FILE.test(filePath) && SERVICE_PATH.test(filePath);
}

/**
 * docs/09: "ViewModel DOM'a dokunmaz".
 *
 * YANLIŞ POZİTİFTEN KAÇINMA: `window.setInterval` bir ZAMANLAYICIDIR, DOM
 * erişimi değil — mevcut viewmodel'lerin çoğu onu kullanır. Gürültü üreten
 * bir denetçi, susturulmak için baseline'a istisna eklenerek aşındırılır;
 * kural bu yüzden DOM erişimini dar hedefler.
 */
export function auditViewModel(
  filePath: string,
  content: string,
): readonly StandardsViolation[] {
  if (!isViewModelFile(filePath)) return [];
  const hit = codeLines(content).find((entry) =>
    /\bdocument\s*\./.test(entry.text)
    || /\.(querySelector|getElementById|innerHTML)\b/.test(entry.text));
  if (hit === undefined) return Object.freeze([]);
  return Object.freeze([{
    ruleId: 'STD-002' as const,
    filePath,
    summary: `ViewModel katmanı DOM'a dokunuyor: ${filePath}. `
      + 'docs/09 gereği DOM erişimi View katmanına aittir.',
    evidenceRefs: [`file:${filePath}:${hit.line}`],
    severity: 'medium' as const,
  }]);
}

/** docs/09: "Service React import etmez" — servis katmanı UI'dan bağımsızdır. */
export function auditService(
  filePath: string,
  content: string,
): readonly StandardsViolation[] {
  if (!isServiceFile(filePath)) return [];
  const hit = codeLines(content).find((entry) =>
    /from\s+['"]react(-dom)?['"]/.test(entry.text)
    || /require\(\s*['"]react(-dom)?['"]\s*\)/.test(entry.text));
  if (hit === undefined) return Object.freeze([]);
  return Object.freeze([{
    ruleId: 'STD-003' as const,
    filePath,
    summary: `Servis katmanı React import ediyor: ${filePath}. `
      + 'docs/09 gereği servis UI framework\'ünden bağımsız olmalı.',
    evidenceRefs: [`file:${filePath}:${hit.line}`],
    severity: 'medium' as const,
  }]);
}

/**
 * Dosyayı AİT OLDUĞU katmanın kurallarına göre denetler.
 *
 * NEDEN VAR: denetçi yalnız görünüm katmanına bakıyordu; `services/` ve
 * `viewmodels/` hiç denetlenmiyordu. docs/09'un altı mvvm kontrolünden
 * yazılı olan bir kısmı fiilen uygulanmıyordu.
 */
export function auditStandards(
  filePath: string,
  content: string,
): readonly StandardsViolation[] {
  return Object.freeze([
    ...auditMvvmView(filePath, content),
    ...auditViewModel(filePath, content),
    ...auditService(filePath, content),
  ]);
}

export function auditMvvmView(
  filePath: string,
  content: string,
): readonly StandardsViolation[] {
  if (!isViewFile(filePath)) return [];
  const violations: StandardsViolation[] = [];
  const lines = codeLines(content);

  const fetchLine = lines.find((entry) => /\bfetch\s*\(/.test(entry.text));
  if (fetchLine !== undefined) {
    violations.push({
      ruleId: 'STD-001',
      filePath,
      summary: `View katmanında doğrudan fetch çağrısı var: ${filePath}. `
        + 'docs/09 gereği veri erişimi ViewModel/Service katmanına taşınmalı.',
      evidenceRefs: [`file:${filePath}:${fetchLine.line}`],
      severity: 'high',
    });
  }

  const stateLine = lines.find((entry) => /\buse(State|Effect|Reducer)\s*</.test(entry.text)
    || /\buse(State|Effect|Reducer)\s*\(/.test(entry.text));
  if (stateLine !== undefined) {
    violations.push({
      ruleId: 'STD-001',
      filePath,
      summary: `View katmanında durum/yan etki mantığı var: ${filePath}. `
        + 'docs/09 gereği useState/useEffect ViewModel hook’una taşınmalı.',
      evidenceRefs: [`file:${filePath}:${stateLine.line}`],
      severity: 'medium',
    });
  }

  return Object.freeze(violations);
}
