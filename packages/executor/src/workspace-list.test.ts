import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspacePaths } from './workspace-paths.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function workspace(files: Readonly<Record<string, string>>): { root: string; paths: WorkspacePaths } {
  const root = mkdtempSync(join(tmpdir(), 'ww-ls-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  return { root, paths: new WorkspacePaths(root) };
}

describe('WorkspacePaths.listFiles', () => {
  // ASIL KUSUR: docs/05'te tanımlı `list_dir` hiç yazılmamıştı; worker hangi
  // dosyaların var olduğunu göremiyor ve canlı koşuda soru sorup duruyordu.
  it('calisma alanindaki dosyalari ic ice listeler', async () => {
    const { paths } = workspace({ 'src/a.ts': 'a', 'src/nested/b.ts': 'b', 'package.json': '{}' });
    expect(await paths.listFiles('')).toEqual(['package.json', 'src/a.ts', 'src/nested/b.ts']);
  });

  it('alt dizini listeler', async () => {
    const { paths } = workspace({ 'src/a.ts': 'a', 'docs/x.md': 'x' });
    expect(await paths.listFiles('src')).toEqual(['src/a.ts']);
  });

  // Depo iç yapısı ve bağımlılıklar iş değildir; agent'ı boğar.
  it('git ve node_modules icerigini gostermez', async () => {
    const { paths } = workspace({
      'src/a.ts': 'a', '.git/config': 'x', 'node_modules/pkg/index.js': 'y',
    });
    expect(await paths.listFiles('')).toEqual(['src/a.ts']);
  });

  // Sembolik bağlantı hedefi kök dışına çıkabilir; listelemek sızıntıdır.
  it('sembolik baglantilari atlar', async () => {
    const { root, paths } = workspace({ 'src/a.ts': 'a' });
    const outside = mkdtempSync(join(tmpdir(), 'ww-out-'));
    roots.push(outside);
    writeFileSync(join(outside, 'secret.txt'), 'gizli');
    symlinkSync(outside, join(root, 'link'));
    expect(await paths.listFiles('')).toEqual(['src/a.ts']);
  });

  it('olmayan dizinde acik hata verir', async () => {
    const { paths } = workspace({ 'src/a.ts': 'a' });
    await expect(paths.listFiles('yok')).rejects.toThrow(/Dizin bulunamadı/);
  });

  // Kapsam dışına çıkan istek reddedilmelidir.
  it('calisma alani disina cikamaz', async () => {
    const { paths } = workspace({ 'src/a.ts': 'a' });
    await expect(paths.listFiles('../..')).rejects.toThrow();
  });

  // Sınırsız listeleme prompt'u boğar ve token bütçesini yakar.
  it('kayit sinirini asmaz', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 20; index += 1) files[`src/f${index}.ts`] = 'x';
    expect((await workspace(files).paths.listFiles('', 5))).toHaveLength(5);
  });
});
