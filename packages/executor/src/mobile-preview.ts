export interface MobilePreviewPort {
  listAvds(): Promise<readonly string[]>;
  /** Şu an bağlı cihazların seri numaraları; adapter destekliyorsa. */
  listDevices?(): Promise<readonly string[]>; start(avd: string): Promise<{ readonly sessionId: string }>; screenshot(sessionId: string): Promise<Uint8Array>; tap(sessionId: string, x: number, y: number): Promise<void>; stop(sessionId: string): Promise<void>; }
export class MobilePreviewError extends Error { constructor(message: string) { super(message); this.name = 'MobilePreviewError'; } }

/** Host-side Android adapter. Process creation remains injected so the
 * executor never shells out on behalf of an untrusted task. */
export interface MobileCommandPort {
  run(command: string, args: readonly string[]): Promise<{ readonly stdout: string; readonly bytes?: Uint8Array }>;
  start(command: string, args: readonly string[]): Promise<{ readonly sessionId: string; readonly stop: () => Promise<void> }>;
}

/** Yeni cihazın adb listesinde belirmesi için yoklama sınırı (~30 sn). */
const NEW_DEVICE_POLL_ATTEMPTS = 30;
const NEW_DEVICE_POLL_INTERVAL_MS = 1_000;

export class AdbMobilePreviewPort implements MobilePreviewPort {
  readonly #commands: MobileCommandPort;
  readonly #emulator: string;
  readonly #adb: string;
  readonly #processes = new Map<string, () => Promise<void>>();

  readonly #sleep: (ms: number) => Promise<void>;

  constructor(commands: MobileCommandPort, options: {
    readonly emulatorCommand?: string;
    readonly adbCommand?: string;
    /** Testler gerçek zamanlayıcıya bağlanmasın diye enjekte edilebilir. */
    readonly sleep?: (ms: number) => Promise<void>;
  } = {}) {
    this.#commands = commands;
    this.#emulator = options.emulatorCommand ?? 'emulator';
    this.#adb = options.adbCommand ?? 'adb';
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  }

  async listAvds(): Promise<readonly string[]> {
    const result = await this.#commands.run(this.#emulator, ['-list-avds']);
    return Object.freeze(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort());
  }

  /**
   * Şu an BAĞLI cihazların seri numaraları (`adb devices`).
   *
   * NEDEN VAR: keşfin tek yolu `emulator -list-avds` idi. O ikili kurulu
   * değilse (yaygın: platform-tools kurulu, emulator paketi değil) panel
   * çalışan cihaz DURURKEN "cihaz yok" diyordu.
   *
   * Yalnız `device` durumundakiler sayılır: `offline`/`unauthorized` bir
   * cihaza yönlendirmek paneli çalışmayan bir hedefe bağlamak olurdu.
   */
  async listDevices(): Promise<readonly string[]> {
    const result = await this.#commands.run(this.#adb, ['devices']);
    return Object.freeze(result.stdout.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('List of devices'))
      .map((line) => line.split(/\s+/))
      .filter((parts) => parts[1] === 'device')
      .map((parts) => parts[0] as string));
  }

  /**
   * Hedef zaten bağlı bir seri numarasıysa ONA BAĞLANIR; değilse AVD kabul
   * edip emülatörü başlatır ve YENİ seri numarasını çözer.
   *
   * NEDEN BÖYLE: eskiden dönen değer başlatılan SÜRECİN kimliğiydi, ama
   * sonraki her çağrı onu `adb -s <seri>` diye kullanıyordu. Süreç kimliği
   * adb seri numarası değildir; gerçek makinede
   * "error: device 'emu-1' not found" ile düşer. Eski test sahtesi süreç
   * kimliğini seri gibi döndürdüğü için kusur görünmüyordu.
   */
  async start(target: string): Promise<{ readonly sessionId: string }> {
    if (!/^[A-Za-z0-9_.:-]+$/.test(target)) throw new MobilePreviewError('hedef adı geçersiz');

    const before = await this.listDevices();
    // Bağlı cihaza bağlanmak süreç BAŞLATMAZ: emulator ikilisi kurulu
    // olmasa bile önizleme çalışır.
    if (before.includes(target)) return { sessionId: target };

    const process = await this.#commands.start(
      this.#emulator, [`@${target}`, '-no-window', '-no-audio', '-no-boot-anim'],
    );
    await this.#commands.run(this.#adb, ['wait-for-device']);
    // `wait-for-device` BAŞKA bir cihaz bağlıyken hemen döner; yeni emülatör
    // henüz listede olmayabilir. Tek bakışta pes etmek, iki cihazlı makinede
    // başlatmayı düpedüz kırardı.
    let serial: string | undefined;
    for (let attempt = 0; attempt < NEW_DEVICE_POLL_ATTEMPTS; attempt += 1) {
      const after = await this.listDevices();
      serial = after.find((candidate) => !before.includes(candidate));
      if (serial !== undefined) break;
      await this.#sleep(NEW_DEVICE_POLL_INTERVAL_MS);
    }
    if (serial === undefined) {
      // Süreç kimliğine düşmek YASAK: sessizce yanlış cihaza konuşmaktansa
      // açık hata ver.
      await process.stop();
      throw new MobilePreviewError('emülatör başlatıldı ama yeni adb cihazı belirmedi');
    }
    this.#processes.set(serial, process.stop);
    return { sessionId: serial };
  }

  async screenshot(sessionId: string): Promise<Uint8Array> {
    const result = await this.#commands.run(this.#adb, ['-s', sessionId, 'exec-out', 'screencap', '-p']);
    if (result.bytes === undefined) throw new MobilePreviewError('ADB kare çıktısı binary olmalıdır');
    return result.bytes;
  }

  async tap(sessionId: string, x: number, y: number): Promise<void> {
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0) throw new MobilePreviewError('dokunma koordinatı güvenli değil');
    await this.#commands.run(this.#adb, ['-s', sessionId, 'shell', 'input', 'tap', String(x), String(y)]);
  }

  /**
   * Yalnız KENDİ başlattığımız cihaz durdurulur. Bağlanılan cihaza
   * `adb emu kill` göndermek, kullanıcının kendi çalıştırdığı emülatörü
   * kapatmak olurdu.
   */
  async stop(sessionId: string): Promise<void> {
    const processStop = this.#processes.get(sessionId);
    if (processStop === undefined) return;
    try { await this.#commands.run(this.#adb, ['-s', sessionId, 'emu', 'kill']); }
    finally { this.#processes.delete(sessionId); await processStop(); }
  }
}
export class MobilePreviewService {
  readonly #port: MobilePreviewPort;
  constructor(port: MobilePreviewPort) { this.#port = port; }
  /**
   * Hedef seçimi: BAĞLI cihaz > AVD.
   *
   * NEDEN: bağlı cihaz hazırdır, AVD ise açılış beklemesi ister — cihaz
   * varken emülatör başlatmak boşuna dakikalar harcar. Ayrıca `listAvds`
   * `emulator` ikilisini çağırır; o paket kurulu değilse ÇAĞRI DÜŞER ve
   * panel iki cihaz ÇALIŞIRKEN "uygun AVD bulunamadı" diyordu.
   */
  async open(preferredTarget?: string): Promise<{ readonly sessionId: string; readonly avd: string }> {
    const devices = this.#port.listDevices === undefined
      ? []
      : await this.#port.listDevices().catch(() => []);
    // AVD listesi alınamazsa iş DURMAZ: bağlı cihaz varken emülatör
    // ikilisinin yokluğu önizlemeyi engellememeli.
    const avds = await this.#port.listAvds().catch(() => [] as readonly string[]);
    const candidates = [...devices, ...avds];
    const avd = preferredTarget === undefined
      ? candidates[0]
      : candidates.find((item) => item === preferredTarget);
    if (avd === undefined) throw new MobilePreviewError('uygun Android cihaz veya AVD bulunamadi');
    const session = await this.#port.start(avd);
    if (session.sessionId.trim().length === 0) throw new MobilePreviewError('emulator session kimligi bos');
    return Object.freeze({ sessionId: session.sessionId, avd });
  }
  async frame(sessionId: string): Promise<Uint8Array> {
    if (sessionId.trim().length === 0) throw new MobilePreviewError('session kimligi bos');
    const image = await this.#port.screenshot(sessionId);
    if (image.length === 0) throw new MobilePreviewError('emulator bos kare dondurdu');
    return image;
  }
  tap(sessionId: string, x: number, y: number): Promise<void> {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) throw new MobilePreviewError('gecersiz dokunma koordinati');
    return this.#port.tap(sessionId, x, y);
  }
}
