import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkspaceFile } from './workspace-file-path.js';

const root = '/w/proje';

describe('resolveWorkspaceFile', () => {
  it('workspace içindeki dosyayı çözer', () => {
    expect(resolveWorkspaceFile(root, 'src/Board.tsx')).toBe(path.resolve(root, 'src/Board.tsx'));
  });

  // GÜVENLİK: sınır olmadan uç, sunucudaki her dosyayı okutur.
  it('.. ile dışarı çıkmayı reddeder', () => {
    expect(() => resolveWorkspaceFile(root, '../../etc/passwd')).toThrow(/workspace dışına/);
  });

  it('derin .. zincirini de reddeder', () => {
    expect(() => resolveWorkspaceFile(root, 'src/../../../gizli.txt')).toThrow(/workspace dışına/);
  });

  it('mutlak yolu reddeder', () => {
    expect(() => resolveWorkspaceFile(root, '/etc/passwd')).toThrow(/göreli/);
  });

  it('boş yolu reddeder', () => {
    expect(() => resolveWorkspaceFile(root, '   ')).toThrow(/boş/);
  });

  it('NUL karakterli yolu reddeder', () => {
    expect(() => resolveWorkspaceFile(root, 'src/a\0.ts')).toThrow(/geçersiz karakter/);
  });

  // Kök adının uzantısı, kapsam kontrolünü aldatmamalı (/w/proje-gizli).
  it('benzer isimli kardeş dizine sızmayı reddeder', () => {
    expect(() => resolveWorkspaceFile(root, '../proje-gizli/x.ts')).toThrow(/workspace dışına/);
  });

  it('workspace kökü göreliyse reddeder', () => {
    expect(() => resolveWorkspaceFile('proje', 'a.ts')).toThrow(/mutlak/);
  });

  it('içerideki ./ kullanımına izin verir', () => {
    expect(resolveWorkspaceFile(root, './src/a.ts')).toBe(path.resolve(root, 'src/a.ts'));
  });
});
