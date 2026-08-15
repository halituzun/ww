export interface MobilePreviewPort { listAvds(): Promise<readonly string[]>; start(avd: string): Promise<{ readonly sessionId: string }>; screenshot(sessionId: string): Promise<Uint8Array>; tap(sessionId: string, x: number, y: number): Promise<void>; stop(sessionId: string): Promise<void>; }
export class MobilePreviewError extends Error { constructor(message: string) { super(message); this.name = 'MobilePreviewError'; } }

/** Host-side Android adapter. Process creation remains injected so the
 * executor never shells out on behalf of an untrusted task. */
export interface MobileCommandPort {
  run(command: string, args: readonly string[]): Promise<{ readonly stdout: string; readonly bytes?: Uint8Array }>;
  start(command: string, args: readonly string[]): Promise<{ readonly sessionId: string; readonly stop: () => Promise<void> }>;
}

export class AdbMobilePreviewPort implements MobilePreviewPort {
  readonly #commands: MobileCommandPort;
  readonly #emulator: string;
  readonly #adb: string;
  readonly #processes = new Map<string, () => Promise<void>>();

  constructor(commands: MobileCommandPort, options: { readonly emulatorCommand?: string; readonly adbCommand?: string } = {}) {
    this.#commands = commands;
    this.#emulator = options.emulatorCommand ?? 'emulator';
    this.#adb = options.adbCommand ?? 'adb';
  }

  async listAvds(): Promise<readonly string[]> {
    const result = await this.#commands.run(this.#emulator, ['-list-avds']);
    return Object.freeze(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort());
  }

  async start(avd: string): Promise<{ readonly sessionId: string }> {
    if (!/^[A-Za-z0-9_.-]+$/.test(avd)) throw new MobilePreviewError('AVD adı geçersiz');
    const process = await this.#commands.start(this.#emulator, [`@${avd}`, '-no-window', '-no-audio', '-no-boot-anim']);
    await this.#commands.run(this.#adb, ['wait-for-device']);
    this.#processes.set(process.sessionId, process.stop);
    return { sessionId: process.sessionId };
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
  async open(preferredAvd?: string): Promise<{ readonly sessionId: string; readonly avd: string }> {
    const avds = await this.#port.listAvds();
    const avd = preferredAvd === undefined ? avds[0] : avds.find((item) => item === preferredAvd);
    if (avd === undefined) throw new MobilePreviewError('uygun Android AVD bulunamadi');
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
