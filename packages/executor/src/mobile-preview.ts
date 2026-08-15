export interface MobilePreviewPort { listAvds(): Promise<readonly string[]>; start(avd: string): Promise<{ readonly sessionId: string }>; screenshot(sessionId: string): Promise<Uint8Array>; tap(sessionId: string, x: number, y: number): Promise<void>; stop(sessionId: string): Promise<void>; }
export class MobilePreviewError extends Error { constructor(message: string) { super(message); this.name = 'MobilePreviewError'; } }
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
