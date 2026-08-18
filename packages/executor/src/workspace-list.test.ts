import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
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

describe('WorkspacePaths.searchText', () => {
  // ASIL KUSUR: worker yalnızca adını bildiği dosyayı okuyabiliyordu;
  // "bu fonksiyon nerede tanımlı" sorusunun cevabı yoktu.
  it('eslesen satiri dosya ve satir numarasiyla bulur', async () => {
    const { paths } = workspace({ 'src/a.ts': 'const x = 1;\nexport function hedef() {}\n' });
    const hits = await paths.searchText('hedef');
    expect(hits).toEqual([{ path: 'src/a.ts', line: 2, text: 'export function hedef() {}' }]);
  });

  it('buyuk kucuk harf ayirmaz', async () => {
    const { paths } = workspace({ 'src/a.ts': 'export function Hedef() {}\n' });
    expect(await paths.searchText('hedef')).toHaveLength(1);
  });

  it('birden fazla dosyada arar', async () => {
    const { paths } = workspace({ 'src/a.ts': 'ara', 'src/b.ts': 'ara' });
    expect((await paths.searchText('ara')).map((h) => h.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('eslesme yoksa bos doner', async () => {
    const { paths } = workspace({ 'src/a.ts': 'x' });
    expect(await paths.searchText('yok')).toEqual([]);
  });

  it('bos deseni reddeder', async () => {
    const { paths } = workspace({ 'src/a.ts': 'x' });
    await expect(paths.searchText('  ')).rejects.toThrow(/boş olamaz/);
  });

  // Sınırsız sonuç prompt'u boğar ve token bütçesini yakar.
  it('sonuc sayisini sinirlar', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 20; index += 1) files[`src/f${index}.ts`] = 'ara';
    expect(await workspace(files).paths.searchText('ara', { maxResults: 5 })).toHaveLength(5);
  });

  // Uzun satır prompt'u boğar.
  it('cok uzun satiri keser', async () => {
    const { paths } = workspace({ 'src/a.ts': `ara${'x'.repeat(500)}` });
    expect((await paths.searchText('ara'))[0]!.text.length).toBeLessThanOrEqual(300);
  });
});

describe('WorkspacePaths.trashFile / moveFile', () => {
  // docs/05: silme ÇÖPE TAŞIMADIR. Gerçek silme, modelin tek bir hatalı
  // adımını kalıcı veri kaybına çevirir.
  it('silinen dosyayi cop klasorune tasir, gercekten silmez', async () => {
    const { root, paths } = workspace({ 'src/a.ts': 'içerik' });
    const target = await paths.trashFile('src/a.ts', 'cagri1');

    expect(target).toBe('.ww-trash/cagri1/src/a.ts');
    expect(readFileSync(join(root, target), 'utf8')).toBe('içerik');
    expect(existsSync(join(root, 'src/a.ts'))).toBe(false);
  });

  // Aynı ada ikinci silme öncekini EZMEZ.
  it('ayni dosyanin ikinci silinisi oncekini ezmez', async () => {
    const { root, paths } = workspace({ 'src/a.ts': 'ilk' });
    await paths.trashFile('src/a.ts', 'cagri1');
    writeFileSync(join(root, 'src/a.ts'), 'ikinci');
    await paths.trashFile('src/a.ts', 'cagri2');

    expect(readFileSync(join(root, '.ww-trash/cagri1/src/a.ts'), 'utf8')).toBe('ilk');
    expect(readFileSync(join(root, '.ww-trash/cagri2/src/a.ts'), 'utf8')).toBe('ikinci');
  });

  it('dosyayi tasir', async () => {
    const { root, paths } = workspace({ 'src/a.ts': 'içerik' });
    await paths.moveFile('src/a.ts', 'src/b.ts');

    expect(readFileSync(join(root, 'src/b.ts'), 'utf8')).toBe('içerik');
    expect(existsSync(join(root, 'src/a.ts'))).toBe(false);
  });

  // Sessiz üzerine yazma veri kaybıdır.
  it('var olan hedefin uzerine yazmaz', async () => {
    const { paths } = workspace({ 'src/a.ts': 'a', 'src/b.ts': 'b' });
    await expect(paths.moveFile('src/a.ts', 'src/b.ts')).rejects.toThrow(/zaten var/);
  });

  it('olmayan dosyayi tasimaz', async () => {
    const { paths } = workspace({ 'src/a.ts': 'a' });
    await expect(paths.moveFile('src/yok.ts', 'src/c.ts')).rejects.toThrow();
  });
});
