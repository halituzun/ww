import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Keystore, maskKey } from './keystore.js';

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ww-keystore-'));
  return join(dir, 'keys.enc.json');
}

describe('Keystore', () => {
  it('set→get roundtrip yapar ve birden çok anahtar tutar', async () => {
    const ks = new Keystore(await tempFile(), randomBytes(32));
    await ks.set('openai', 'sk-openai-12345678');
    await ks.set('anthropic', 'sk-ant-abcdefgh');
    expect(await ks.get('openai')).toBe('sk-openai-12345678');
    expect(await ks.get('anthropic')).toBe('sk-ant-abcdefgh');
    expect(await ks.get('deepseek')).toBeUndefined();
  });

  it('dosya düz metin anahtar içermez ve 0600 izinlidir', async () => {
    const file = await tempFile();
    const ks = new Keystore(file, randomBytes(32));
    await ks.set('openai', 'sk-cok-gizli-anahtar');
    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain('sk-cok-gizli-anahtar');
    expect(JSON.parse(raw)).toMatchObject({ v: 1 });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('yanlış master key ile çözemez', async () => {
    const file = await tempFile();
    await new Keystore(file, randomBytes(32)).set('openai', 'sk-x');
    await expect(new Keystore(file, randomBytes(32)).get('openai')).rejects.toThrow(/çözülemedi|decrypt/i);
  });

  it('listProviders kayıtlı sağlayıcıları döner', async () => {
    const ks = new Keystore(await tempFile(), randomBytes(32));
    await ks.set('openai', 'a');
    await ks.set('deepseek', 'b');
    expect((await ks.listProviders()).sort()).toEqual(['deepseek', 'openai']);
  });
});

it('maskKey anahtarı maskeler', () => {
  expect(maskKey('sk-abcdef1234')).toBe('sk-…1234');
  expect(maskKey('abc')).toBe('…');
});
