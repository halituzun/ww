import { describe, expect, it } from 'vitest';
import { buildKnowledgeRow, parseKnowledgeInput } from './knowledge.service.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const base = { kind: 'decision' as const, title: 'React kullanılacak', content: 'MVVM ile React seçildi.' };

describe('parseKnowledgeInput', () => {
  it('geçerli kaydı kabul eder', () => {
    expect(parseKnowledgeInput(base).title).toBe(base.title);
  });

  // İçeriksiz bir "karar", hafızaya yazılmış bir başlıktan ibarettir.
  it('boş içeriği reddeder', () => {
    expect(() => parseKnowledgeInput({ ...base, content: '  ' })).toThrow();
  });

  it('boş başlığı reddeder', () => {
    expect(() => parseKnowledgeInput({ ...base, title: '' })).toThrow();
  });

  it('bilinmeyen türü reddeder', () => {
    expect(() => parseKnowledgeInput({ ...base, kind: 'uydurma' })).toThrow();
  });

  it('etiketleri korur', () => {
    expect(parseKnowledgeInput({ ...base, tags: ['mimari'] }).tags).toEqual(['mimari']);
  });
});

describe('buildKnowledgeRow', () => {
  const now = '2026-08-17T09:00:00.000Z';

  it('projeye bağlı satır kurar', () => {
    const row = buildKnowledgeRow(projectId, parseKnowledgeInput(base), now);
    expect(row).toMatchObject({ project_id: projectId, kind: 'decision', status: 'active' });
  });

  it('her kayda benzersiz kimlik verir', () => {
    const a = buildKnowledgeRow(projectId, parseKnowledgeInput(base), now);
    const b = buildKnowledgeRow(projectId, parseKnowledgeInput(base), now);
    expect(a['knowledge_id']).not.toBe(b['knowledge_id']);
  });

  // Kaynağı olan bilgi izlenebilir olur: "bu kararı hangi iş doğurdu".
  it('kaynak görevi taşır', () => {
    const row = buildKnowledgeRow(
      projectId,
      parseKnowledgeInput({ ...base, sourceTaskId: '00000000-0000-4000-8000-000000000009' }),
      now,
    );
    expect(row['source_task_id']).toBe('00000000-0000-4000-8000-000000000009');
  });

  it('kaynak yoksa NIL bırakır', () => {
    const row = buildKnowledgeRow(projectId, parseKnowledgeInput(base), now);
    expect(row['source_task_id']).toBe('00000000-0000-0000-0000-000000000000');
  });
});
