import { describe, expect, it } from 'vitest';
import { readDevPort, withDevPort, withoutDevPort } from './preview-port-store.js';

const MIN = 42_000;
const MAX = 42_999;

describe('readDevPort', () => {
  it('kayitli portu okur', () => {
    expect(readDevPort({ dev_port: 42_005 }, MIN, MAX)).toBe(42_005);
  });

  it('metin olarak yazilmis portu da okur', () => {
    expect(readDevPort({ dev_port: '42005' }, MIN, MAX)).toBe(42_005);
  });

  // Havuz dışındaki bir portu kullanmak, başka bir servisin portunu çalmaktır.
  it('havuz disindaki portu yok sayar', () => {
    expect(readDevPort({ dev_port: 80 }, MIN, MAX)).toBeUndefined();
    expect(readDevPort({ dev_port: 99_999 }, MIN, MAX)).toBeUndefined();
  });

  it('bozuk ya da eksik degerde uydurma yapmaz', () => {
    expect(readDevPort({ dev_port: 'abc' }, MIN, MAX)).toBeUndefined();
    expect(readDevPort({}, MIN, MAX)).toBeUndefined();
    expect(readDevPort(null, MIN, MAX)).toBeUndefined();
  });
});

describe('withDevPort / withoutDevPort', () => {
  it('portu yazar', () => {
    expect(withDevPort({}, 42_001)).toEqual({ dev_port: 42_001 });
  });

  // Diğer ayarları ezmek, ilgisiz yapılandırmayı sessizce silmek olurdu.
  it('diger ayarlara dokunmaz', () => {
    expect(withDevPort({ tema: 'koyu' }, 42_001)).toEqual({ tema: 'koyu', dev_port: 42_001 });
  });

  // Süreç kapanınca kayıt "çalışıyor" yalanını söylememeli.
  it('portu siler ve digerlerini korur', () => {
    expect(withoutDevPort({ tema: 'koyu', dev_port: 42_001 })).toEqual({ tema: 'koyu' });
  });

  it('bozuk ayar nesnesinde patlamaz', () => {
    expect(withDevPort(null, 42_001)).toEqual({ dev_port: 42_001 });
    expect(withoutDevPort(undefined)).toEqual({});
  });
});
