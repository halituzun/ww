import { describe, expect, it } from 'vitest';
import { parseGateConfig } from '@ww/executor';
import { defaultGateConfig, starterFiles } from './project-scaffold.js';

describe('defaultGateConfig', () => {
  // ASIL KUSUR: ww.gate.json hiç yazılmıyordu; iş üretilebiliyor ama kapı
  // adımında "Dosya bulunamadı" ile düşüp asla kabul edilemiyordu.
  it('web projesi için geçerli kapı yapılandırması üretir', () => {
    expect(() => parseGateConfig(defaultGateConfig('web'))).not.toThrow();
  });

  it('api projesi için de geçerlidir', () => {
    expect(() => parseGateConfig(defaultGateConfig('api'))).not.toThrow();
  });

  it('mobil projesi için de geçerlidir', () => {
    expect(() => parseGateConfig(defaultGateConfig('mobile'))).not.toThrow();
  });

  it('web kapısı tip kontrolü çalıştırır', () => {
    expect(defaultGateConfig('web').steps.map((step) => step.name)).toContain('typecheck');
  });

  it('fullstack projesi için de geçerlidir', () => {
    expect(() => parseGateConfig(defaultGateConfig('fullstack'))).not.toThrow();
  });

  // Uydurma kapı "geçti" yalanı olurdu; bilinmeyen tür yapılandırma hatasıdır.
  it('bilinmeyen tür için uydurma kapı üretmez', () => {
    expect(() => defaultGateConfig('bilinmiyor')).toThrow(/bilinmeyen proje türü/);
  });

  it('üretilen çıktıları kapı girdisi saymaz', () => {
    expect(defaultGateConfig('web').discardedOutputs).toContain('node_modules');
  });

  // Her girdi DOSYA olarak okunur; dizin listelemek kapıyı EISDIR ile düşürür.
  it('kapı girdisi olarak dizin listelemez', () => {
    expect(defaultGateConfig('web').inputs).not.toContain('src');
  });

});

describe('starterFiles', () => {
  // Kapı girdileri var olmayan dosyaya işaret edince iş doğrulamayı geçse
  // bile kabul edilemiyordu.
  it('web projesi kapı girdilerini karşılar', () => {
    const files = starterFiles('web', 'satranc');
    for (const input of defaultGateConfig('web').inputs) {
      expect(files.has(input)).toBe(true);
    }
  });

  it('package.json geçerli JSON üretir', () => {
    const raw = starterFiles('web', 'satranc').get('package.json')!;
    expect(JSON.parse(raw).name).toBe('satranc');
  });

  it('tsconfig strict açık gelir', () => {
    const raw = starterFiles('web', 'satranc').get('tsconfig.json')!;
    expect(JSON.parse(raw).compilerOptions.strict).toBe(true);
  });

  it('mobil projesi için node dosyası üretmez', () => {
    expect(starterFiles('mobile', 'x').size).toBe(0);
  });
});
