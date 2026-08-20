import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// API anahtarları ASLA ClickHouse'a yazılmaz (docs/04 → Anahtar Güvenliği).
// Depo: AES-256-GCM ile şifreli yerel dosya; ana anahtar env ya da macOS Keychain'de.
interface KeyfileV1 {
  v: 1;
  nonce: string; // base64
  data: string; // base64(ciphertext + authTag)
}

type KeyMap = Record<string, string>;

const KEYCHAIN_SERVICE = 'ww-master';

// Keystore dosya yolu: WW_KEYSTORE_FILE verilmişse o kullanılır. Verilmediyse
// cwd'den yukarı doğru workspace kökü (pnpm-workspace.yaml) aranır ve
// <kök>/.ww/keys.json döner; işaretçi bulunamazsa eski davranışa
// (<cwd>/.ww/keys.json) düşülür. Böylece turbo altında apps/server cwd'siyle
// başlatılan süreç de depo kökündeki dosyayı bulur — yanlış cwd eskiden
// sessiz no_key'e yol açıyordu.
export function resolveKeystoreFile(cwd = process.cwd()): string {
  const fromEnv = process.env['WW_KEYSTORE_FILE'];
  if (fromEnv) return fromEnv;
  const start = resolve(cwd);
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return join(dir, '.ww', 'keys.json');
    const parent = dirname(dir);
    if (parent === dir) return join(start, '.ww', 'keys.json');
    dir = parent;
  }
}

export class Keystore {
  constructor(
    private readonly file: string,
    private readonly masterKey: Buffer,
  ) {
    if (masterKey.length !== 32) throw new Error('master key 32 bayt olmalı');
  }

  static async open(file: string): Promise<Keystore> {
    return new Keystore(file, await resolveMasterKey());
  }

  async get(providerId: string): Promise<string | undefined> {
    return (await this.readAll())[providerId];
  }

  async set(providerId: string, apiKey: string): Promise<void> {
    const all = await this.readAll();
    all[providerId] = apiKey;
    await this.writeAll(all);
  }

  async remove(providerId: string): Promise<void> {
    const all = await this.readAll();
    delete all[providerId];
    await this.writeAll(all);
  }

  async listProviders(): Promise<string[]> {
    return Object.keys(await this.readAll());
  }

  private async readAll(): Promise<KeyMap> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      // Yalnızca "dosya yok" boş depo sayılır (henüz anahtar girilmemiş).
      // EACCES/EISDIR gibi hatalar sessizce no_key'e dönüşmemeli.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
    const parsed = JSON.parse(raw) as KeyfileV1;
    if (parsed.v !== 1) throw new Error(`desteklenmeyen anahtar dosyası sürümü: ${parsed.v}`);

    const nonce = Buffer.from(parsed.nonce, 'base64');
    const blob = Buffer.from(parsed.data, 'base64');
    const tag = blob.subarray(blob.length - 16);
    const ciphertext = blob.subarray(0, blob.length - 16);

    try {
      const decipher = createDecipheriv('aes-256-gcm', this.masterKey, nonce);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(plain.toString('utf8')) as KeyMap;
    } catch {
      throw new Error('anahtar dosyası çözülemedi (yanlış master key veya bozuk dosya)');
    }
  }

  private async writeAll(map: KeyMap): Promise<void> {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(map), 'utf8'), cipher.final()]);
    const payload: KeyfileV1 = {
      v: 1,
      nonce: nonce.toString('base64'),
      data: Buffer.concat([ciphertext, cipher.getAuthTag()]).toString('base64'),
    };
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(payload), { mode: 0o600 });
  }
}

// Master key: önce WW_MASTER_KEY (hex), yoksa macOS Keychain (yoksa üretilip saklanır).
async function resolveMasterKey(): Promise<Buffer> {
  const fromEnv = process.env['WW_MASTER_KEY'];
  if (fromEnv) return Buffer.from(fromEnv, 'hex');

  try {
    const { stdout } = await exec('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w']);
    return Buffer.from(stdout.trim(), 'hex');
  } catch (err) {
    // security: 44 = errSecItemNotFound (girdi gerçekten yok). Diğer hatalar
    // geçici olabilir (keychain kilitli, headless oturum); bu durumda yeni
    // rastgele anahtar üretip mevcut girdinin üstüne yazmak depodaki tüm
    // anahtarları kalıcı olarak çözülemez yapar — hatayı fırlat, üretme.
    if ((err as { code?: unknown }).code !== 44) {
      throw new Error(
        'Keychain okunamadı; mevcut ana anahtar korundu (geçici hata olabilir)',
        { cause: err },
      );
    }
    const key = randomBytes(32);
    await exec('security', [
      'add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'ww', '-w', key.toString('hex'),
    ]);
    return key;
  }
}

export const maskKey = (k: string): string => (k.length <= 4 ? '…' : `${k.slice(0, 3)}…${k.slice(-4)}`);

// Loglara anahtar sızmasını engeller (docs/04 → sızma koruması).
export function redactKeys(text: string): string {
  return text.replace(/\b(sk-|sk-ant-|ds-)[A-Za-z0-9_-]{8,}/g, (m) => `${m.slice(0, 3)}…REDACTED`);
}
