// docs/09 `db_write_audit` (b) — ww KAYITLARININ TAMLIĞI (meta-denetim).
//
// NEDEN VAR: docs/09 bu denetçiyi tanımlıyor ama yalnızca profil ADI bir
// sabit olarak vardı; uygulaması yoktu. Oysa denetlediği şey tam da bu
// deponun tekrar eden en pahalı hatasının imzası: iş "bitti" görünür, kayıt
// ise yoktur. Canlı veritabanında `artifacts` ve `file_index` uzun süre BOŞ
// kaldı ve bunu kimse fark etmedi çünkü hiçbir şey hata vermiyordu.
//
// Denetim deterministiktir: modele sorulmaz, çünkü "kayıt var mı" fikir
// değil olgudur.

export interface AuditedTaskRecord {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly commitHash: string;
  readonly artifactCount: number;
  /** Görevin yazmakla yükümlü olduğu dosyalar. */
  readonly targetFiles: readonly string[];
  /** `file_index`'te kaydı bulunan dosyalar. */
  readonly indexedFiles: readonly string[];
}

export interface RecordViolation {
  readonly ruleId: 'REC-001' | 'REC-002' | 'REC-003';
  readonly taskId: string;
  readonly summary: string;
  readonly severity: 'high' | 'medium';
}

export function auditTaskRecords(
  tasks: readonly AuditedTaskRecord[],
): readonly RecordViolation[] {
  const violations: RecordViolation[] = [];

  for (const task of tasks) {
    // Bitmemiş görev için kayıt beklemek YANLIŞ ALARM üretir: iş sürüyorsa
    // commit'i de artifact'ı da olmaması normaldir. Gürültü kapıyı aşındırır.
    if (task.status !== 'done') continue;

    if (task.commitHash.trim() === '') {
      violations.push({
        ruleId: 'REC-001',
        taskId: task.taskId,
        summary: `"${task.title}" görevi done ama commit_hash boş: `
          + 'iş kalıcılaşmamış olabilir.',
        // En yüksek önem: "bitti" diyen ama ortada kalıcı çıktı olmayan görev,
        // yol haritasını da yanlış gösterir.
        severity: 'high',
      });
    }

    if (task.artifactCount === 0) {
      violations.push({
        ruleId: 'REC-002',
        taskId: task.taskId,
        summary: `"${task.title}" görevi done ama hiç artifacts kaydı yok.`,
        severity: 'medium',
      });
    }

    const missing = task.targetFiles.filter((file) => !task.indexedFiles.includes(file));
    if (missing.length > 0) {
      violations.push({
        ruleId: 'REC-003',
        taskId: task.taskId,
        // Fihristsiz dosya sonraki görevlerin BAĞLAMINDA görünmez olur:
        // hafıza katmanı yazılır ama o dosya hakkında hiçbir şey bilmez.
        summary: `"${task.title}" görevinin dokunduğu dosyalar fihriste girmemiş: `
          + missing.join(', '),
        severity: 'medium',
      });
    }
  }

  return Object.freeze(violations);
}
