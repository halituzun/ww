import { describe, expect, it } from 'vitest';
import { councilDiscussionSource, councilDiscussionText } from './council.controller.js';

describe('CouncilController discussion projection', () => {
  it('protokol payload metnini markdown/summary/text sırasıyla çıkarır', () => {
    expect(councilDiscussionText({ type: 'proposal', markdown: 'Araştırma sonucu' })).toBe('Araştırma sonucu');
    expect(councilDiscussionText({ type: 'synthesis', markdown: 'Nihai karar' })).toBe('Nihai karar');
    expect(councilDiscussionText({ type: 'report', summary: 'Özet kayıt' })).toBe('Özet kayıt');
    expect(councilDiscussionText({ type: 'answer', text: 'PM cevabı' })).toBe('PM cevabı');
  });

  it('dinamik konsey tur türünü provenance.sourceVersion üzerinden taşır', () => {
    expect(councilDiscussionSource(
      { class: 'agent_message', sourceId: 'turn-5', sourceVersion: 'research' },
      'proposal',
    )).toEqual({
      sourceId: 'turn-5',
      sourceVersion: 'research',
      councilKind: 'research',
    });
  });

  it('sourceVersion yoksa kayıt kind alanına düşer', () => {
    expect(councilDiscussionSource({ sourceId: 'turn-1' }, 'proposal')).toEqual({
      sourceId: 'turn-1',
      sourceVersion: '',
      councilKind: 'proposal',
    });
  });
});
