import { describe, expect, it } from 'vitest';
import { classifyArtifact, classifyLayer } from './artifact-classify.js';

describe('classifyArtifact', () => {
  it('React bileşenini component sayar', () => {
    expect(classifyArtifact('src/Board.tsx')).toBe('component');
  });

  // 'src/view/a.test.tsx' bir görünüm değil testtir; sıra önemli.
  it('testi bileşenden önce tanır', () => {
    expect(classifyArtifact('src/view/Board.test.tsx')).toBe('test');
  });

  it('viewmodel’i hook adından tanır', () => {
    expect(classifyArtifact('src/viewmodels/useBoard.ts')).toBe('viewmodel');
  });

  it('controller ve repository’yi ayırt eder', () => {
    expect(classifyArtifact('src/plans.controller.ts')).toBe('controller');
    expect(classifyArtifact('src/repositories/plans.ts')).toBe('repository');
  });

  it('dokümanı ve yapılandırmayı tanır', () => {
    expect(classifyArtifact('docs/01-mimari.md')).toBe('doc');
    expect(classifyArtifact('ww.gate.json')).toBe('config');
  });
});

describe('classifyLayer', () => {
  it('bileşeni view katmanına koyar', () => {
    expect(classifyLayer('src/Board.tsx')).toBe('view');
  });

  it('hook’u viewmodel katmanına koyar', () => {
    expect(classifyLayer('src/viewmodels/useBoard.ts')).toBe('viewmodel');
  });

  it('servisi model katmanına koyar', () => {
    expect(classifyLayer('src/services/api.ts')).toBe('model');
  });

  // Bilinmeyen için uydurma katman, fihristi yanlış bilgiyle doldurur.
  it('bilinmeyeni other bırakır', () => {
    expect(classifyLayer('README.md')).toBe('other');
  });
});
