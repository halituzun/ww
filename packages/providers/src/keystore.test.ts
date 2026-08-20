import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keystore, maskKey, resolveKeystoreFile } from './keystore.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

type ExecCb = (err: unknown, result?: { stdout: string; stderr: string }) => void;

// keystore.ts modül düzeyinde promisify(execFile) kullanır; mock vi.fn()
// callback-kipinde sarmalanır ve son argüman her zaman callback'tir.
function stubSecurity(impl: (args: string[], cb: ExecCb) => void): void {
  vi.mocked(execFile).mockImplementation(((...callArgs: unknown[]) => {
    impl(callArgs[1] as string[], callArgs[callArgs.length - 1] as ExecCb);
  }) as never);
}

function securityError(code: number, message: string): Error & { code: number } {
  const err = new Error(message) as Error & { code: number };
  err.code = code;
  return err;
}

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

  it('dosya hiç yoksa (ENOENT) boş depo sayar', async () => {
    const ks = new Keystore(await tempFile(), randomBytes(32));
    expect(await ks.get('openai')).toBeUndefined();
  });

  it('ENOENT dışı okuma hatasını sessizce boş depo SAYMAZ, fırlatır', async () => {
    const file = await tempFile();
    await mkdir(file, { recursive: true }); // yol bir dizin → readFile EISDIR verir
    await expect(new Keystore(file, randomBytes(32)).get('openai')).rejects.toThrow();
  });
});

describe('resolveKeystoreFile', () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
  });

  it('WW_KEYSTORE_FILE verilmişse onu döner', () => {
    vi.stubEnv('WW_KEYSTORE_FILE', '/tmp/onerilen-keys.json');
    expect(resolveKeystoreFile()).toBe('/tmp/onerilen-keys.json');
  });

  it('env yoksa workspace kökünü (pnpm-workspace.yaml) yukarı arayarak bulur', async () => {
    vi.stubEnv('WW_KEYSTORE_FILE', '');
    const root = await mkdtemp(join(tmpdir(), 'ww-ws-'));
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    const nested = join(root, 'apps', 'server');
    await mkdir(nested, { recursive: true });
    process.chdir(nested); // turbo altındaki server cwd'sini taklit eder
    // cwd symlink'ten arındırılmış döner (macOS: /var → /private/var)
    expect(resolveKeystoreFile()).toBe(join(await realpath(root), '.ww', 'keys.json'));
  });

  it('işaretçi bulunamazsa <cwd>/.ww/keys.json yoluna düşer', async () => {
    vi.stubEnv('WW_KEYSTORE_FILE', '');
    const dir = await mkdtemp(join(tmpdir(), 'ww-nows-'));
    process.chdir(dir);
    expect(resolveKeystoreFile()).toBe(join(await realpath(dir), '.ww', 'keys.json'));
  });
});

describe('Keystore.open — Keychain dalı', () => {
  beforeEach(() => {
    vi.stubEnv('WW_MASTER_KEY', ''); // env yokmuş gibi: Keychain yoluna düşür
    vi.mocked(execFile).mockReset();
  });

  afterEach(() => vi.unstubAllEnvs());

  it('girdi gerçekten yoksa (kod 44) yeni anahtar üretip Keychain’e saklar', async () => {
    stubSecurity((args, cb) => {
      if (args[0] === 'find-generic-password') cb(securityError(44, 'item not found'));
      else cb(null, { stdout: '', stderr: '' });
    });
    const ks = await Keystore.open(await tempFile());
    await ks.set('openai', 'sk-x'); // üretilen anahtarla yazıp okuyabilmeli
    expect(await ks.get('openai')).toBe('sk-x');
    expect(
      vi.mocked(execFile).mock.calls.some((c) => (c[1] as string[])[0] === 'add-generic-password'),
    ).toBe(true);
  });

  it('geçici Keychain hatasında mevcut girdinin üstüne YAZMAZ, hatayı fırlatır', async () => {
    stubSecurity((_args, cb) => cb(securityError(128, 'User interaction is not allowed')));
    await expect(Keystore.open(await tempFile())).rejects.toThrow(/Keychain okunamadı/);
    expect(
      vi.mocked(execFile).mock.calls.some((c) => (c[1] as string[])[0] === 'add-generic-password'),
    ).toBe(false);
  });
});

it('maskKey anahtarı maskeler', () => {
  expect(maskKey('sk-abcdef1234')).toBe('sk-…1234');
  expect(maskKey('abc')).toBe('…');
});
