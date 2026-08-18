import { describe, expect, it } from 'vitest';
import { auditTaskRecords } from './record-audit.js';

const task = (over: Partial<Parameters<typeof auditTaskRecords>[0][number]> = {}) => ({
  taskId: 't1', title: 'Renk paleti', status: 'done',
  commitHash: 'b849854', artifactCount: 1,
  targetFiles: ['src/colors.ts'], indexedFiles: ['src/colors.ts'],
  ...over,
});

describe('auditTaskRecords', () => {
  it('kayitlari tam olan gorevde bulgu yoktur', () => {
    expect(auditTaskRecords([task()])).toEqual([]);
  });

  // docs/09 db_write_audit (b): "tasks.commit_hash boş kalan done görev var mı?"
  // Bu, deponun en pahalı sessiz hatasının imzasıdır: görev "bitti" görünür
  // ama ortada commit yoktur, yani iş aslında hiç kalıcılaşmamıştır.
  it('done gorev commitsizse bulgu acar', () => {
    const found = auditTaskRecords([task({ commitHash: '' })]);
    expect(found).toHaveLength(1);
    expect(found[0]!.ruleId).toBe('REC-001');
    expect(found[0]!.severity).toBe('high');
  });

  it('done gorev artifact yazmadiysa bulgu acar', () => {
    const found = auditTaskRecords([task({ artifactCount: 0 })]);
    expect(found.map((f) => f.ruleId)).toEqual(['REC-002']);
  });

  // "Dokunulan her dosyanın file_index kaydı güncel mi?" — fihristsiz dosya,
  // sonraki görevlerin bağlamında GÖRÜNMEZ olur: hafıza katmanı yazılır ama
  // o dosya hakkında hiçbir şey bilmez.
  it('fihriste girmemis hedef dosyayi bildirir', () => {
    const found = auditTaskRecords([task({
      targetFiles: ['src/colors.ts', 'src/theme.ts'], indexedFiles: ['src/colors.ts'],
    })]);
    expect(found).toHaveLength(1);
    expect(found[0]!.ruleId).toBe('REC-003');
    expect(found[0]!.summary).toContain('src/theme.ts');
  });

  // Bitmemiş görev için kayıt beklemek YANLIŞ ALARM üretir: iş daha
  // sürüyor, commit'i de artifact'ı da olmaması normaldir.
  it('done olmayan gorevi denetlemez', () => {
    expect(auditTaskRecords([task({
      status: 'working', commitHash: '', artifactCount: 0, indexedFiles: [],
    })])).toEqual([]);
  });

  it('ayni gorevdeki birden cok eksigi ayri ayri bildirir', () => {
    const found = auditTaskRecords([task({ commitHash: '', artifactCount: 0 })]);
    expect(found.map((f) => f.ruleId).sort()).toEqual(['REC-001', 'REC-002']);
  });

  // Hedef dosyası olmayan görev (ör. araştırma) fihrist beklemez.
  it('hedef dosyasi olmayan gorev fihrist beklemez', () => {
    expect(auditTaskRecords([task({ targetFiles: [], indexedFiles: [] })])).toEqual([]);
  });
});
