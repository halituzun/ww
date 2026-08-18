import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { GATE_CHECK_FILENAME, GATE_CHECK_SCRIPT } from './gate-check-script.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Betik PROJEDE nasıl çalışacaksa aynen öyle çalıştırılır. */
function runGate(files: Readonly<Record<string, string>>): { ok: boolean; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'ww-gate-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  writeFileSync(join(root, GATE_CHECK_FILENAME), GATE_CHECK_SCRIPT);
  try {
    const output = execFileSync(process.execPath, [GATE_CHECK_FILENAME], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

describe('kapı denetim betiği', () => {
  it('saglikli projeyi gecirir', () => {
    const result = runGate({ 'src/a.ts': 'export const a = 1;\n' });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('kapi denetimi gecti');
  });

  it('kaynak dosya yoksa duser', () => {
    expect(runGate({}).output).toContain('kaynak dosya yok');
  });

  it('bos dosyada duser', () => {
    expect(runGate({ 'src/a.ts': '   ' }).output).toContain('bos dosya');
  });

  // ASIL KUSUR SINIFI: model cevabını kod bloğu olarak yazınca dosya
  // derlenemez hâle gelir ve bu sessizce commit'lenir.
  it('markdown kod citi sizan dosyada duser', () => {
    const result = runGate({ 'src/a.ts': '```ts\nexport const a = 1;\n```\n' });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('markdown kod citi');
  });

  it('birlestirme catismasi isaretinde duser', () => {
    const result = runGate({
      'src/a.ts': 'export const a = 1;\n<<<<<<< HEAD\nexport const b = 2;\n=======\n',
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('birlestirme catismasi');
  });

  it('bozuk JSONda duser', () => {
    const result = runGate({ 'src/a.ts': 'export const a = 1;\n', 'package.json': '{ bozuk' });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('bozuk JSON');
  });

  it('gecerli JSONu sorun saymaz', () => {
    const result = runGate({ 'src/a.ts': 'export const a = 1;\n', 'package.json': '{"name":"x"}' });
    expect(result.ok).toBe(true);
  });

  // Tek bir sorun için tüm listeyi görmek, kapıyı tek tek koşturmaktan iyidir.
  it('birden fazla sorunu birlikte bildirir', () => {
    const result = runGate({ 'src/a.ts': '```\n', 'src/b.ts': '   ' });
    expect(result.output).toContain('markdown kod citi');
    expect(result.output).toContain('bos dosya');
  });
});
