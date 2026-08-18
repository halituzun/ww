// Yeni projenin workspace iskeleti.
//
// NEDEN VAR: görev doğrulamayı geçip KAPI adımına ulaştığında
// `Dosya bulunamadı: ww.gate.json` ile düşüyordu. Kapı, projenin derleme/
// test komutlarını bu dosyadan okur (docs/05 → çalıştırma/test kapısı) ama
// proje oluşturulurken hiç yazılmıyordu: iş üretilebiliyor ama HİÇBİR ZAMAN
// kabul edilemiyordu.
import type { GateConfigLike } from './project-scaffold-types.js';
import { GATE_CHECK_FILENAME, GATE_CHECK_SCRIPT } from './gate-check-script.js';

/** Kapı adımları proje türüne göre değişir; tür bilinmiyorsa en dar küme. */
export function defaultGateConfig(projectType: string): GateConfigLike {
  if (projectType === 'web' || projectType === 'api' || projectType === 'fullstack') {
    return {
      version: 1,
      // Girdiler DOSYA olmalı: dizin listelemek kapıyı EISDIR ile düşürür.
      // Göreve özgü kaynaklar çalışma anında eklenir (brief.targetFiles).
      inputs: ['package.json', 'tsconfig.json', GATE_CHECK_FILENAME],
      discardedOutputs: ['node_modules', 'dist'],
      // `npx tsc` sandbox'ta ÇALIŞMAZ: yeni projede node_modules yok ve ağ
      // kapalı; kapı her zaman exit 1 verir ve hiçbir iş kabul edilemez
      // (canlı koşuda `gate_step:typecheck:failed:1` ile doğrulandı).
      // Bu yüzden kapı bağımlılıksızdır ama artık gerçekten denetler:
      // markdown çiti sızması, çakışma artığı, boş dosya, bozuk JSON
      // (bkz. gate-check-script.ts). Proje kendi bağımlılıklarını kurunca
      // ww.gate.json zenginleştirilebilir.
      steps: [
        {
          name: 'gate_check',
          command: 'node',
          args: [GATE_CHECK_FILENAME],
          timeoutSec: 60,
        },
      ],
    };
  }
  if (projectType === 'mobile') {
    return {
      version: 1,
      inputs: ['pubspec.yaml'],
      discardedOutputs: ['build', '.dart_tool'],
      steps: [
        { name: 'analyze', command: 'flutter', args: ['analyze'], timeoutSec: 300 },
      ],
    };
  }
  // Bilinmeyen tür için UYDURMA kapı üretilmez: adımsız kapı şemaya aykırı,
  // rastgele bir komut ise "geçti" yalanı olurdu. PROJECT_TYPES kapalı bir
  // kümedir; buraya düşmek yapılandırma hatasıdır ve görünmelidir.
  throw new Error(`bilinmeyen proje türü için kapı yapılandırması yok: ${projectType}`);
}

/**
 * Kapının okuduğu asgari proje dosyaları (docs/09 → starter template).
 * Bunlar olmadan kapı `Dosya bulunamadı: package.json` ile düşer: iş
 * doğrulamayı geçse bile kabul edilemez.
 */
export function starterFiles(projectType: string, projectName: string): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  if (projectType === 'web' || projectType === 'api' || projectType === 'fullstack') {
    // Kapı betiği bir GİRDİDİR: starter üretmezse mühürlü kapı zincirinde
    // dosya bulunamaz ve kapı hiç çalıştırılamaz.
    files.set(GATE_CHECK_FILENAME, GATE_CHECK_SCRIPT);
    files.set('package.json', `${JSON.stringify({
      name: projectName,
      private: true,
      version: '0.0.0',
      type: 'module',
    }, null, 2)}\n`);
    files.set('tsconfig.json', `${JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        jsx: 'react-jsx',
        noEmit: true,
        skipLibCheck: true,
      },
      include: ['src'],
    }, null, 2)}\n`);
  }
  return files;
}
