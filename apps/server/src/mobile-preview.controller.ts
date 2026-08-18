// Emülatör önizleme uçları (docs/10 → test ortamları).
//
// NEDEN VAR: `MobilePreviewService`/`AdbMobilePreviewPort` yazılmıştı ama
// hiçbir üretim yolu onları çağırmıyordu: emülatör önizleme ürün olarak yoktu.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  BadRequestException, Body, Controller, Delete, Get, Injectable, Param, Post, Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AdbMobilePreviewPort, MobilePreviewError, MobilePreviewService } from '@ww/executor';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { assertMobileArgs, assertMobileCommand } from './mobile-command-allowlist.js';
import { mobileTargets } from './mobile-targets.js';

const execFileAsync = promisify(execFile);

/** Host komut köprüsü. Komut ve argümanlar beyaz listeden geçmeden çalışmaz. */
@Injectable()
export class MobileCommands {
  async run(command: string, args: readonly string[]) {
    const safe = assertMobileCommand(command);
    const safeArgs = assertMobileArgs(args);
    const { stdout } = await execFileAsync(safe, [...safeArgs], {
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    });
    return { stdout: stdout.toString('utf8'), bytes: new Uint8Array(stdout) };
  }

  async start(command: string, args: readonly string[]) {
    const safe = assertMobileCommand(command);
    const safeArgs = assertMobileArgs(args);
    const child = spawn(safe, [...safeArgs], { stdio: 'ignore', detached: false });
    return {
      sessionId: String(child.pid ?? 0),
      stop: async () => { child.kill('SIGTERM'); },
    };
  }
}

@Controller('mobile-preview')
export class MobilePreviewController {
  readonly #service = new MobilePreviewService(
    new AdbMobilePreviewPort(new MobileCommands()),
  );

  /** Emülatör kurulu değilse bu AÇIKÇA söylenir; boş liste "her şey yolunda" der. */
  #unavailable(reason: unknown): never {
    const message = reason instanceof Error ? reason.message : String(reason);
    if (/ENOENT|not found|bulunamadı/i.test(message)) {
      throw new ServiceUnavailableException(
        `emülatör araçları bulunamadı (Android SDK kurulu mu?): ${message}`,
      );
    }
    if (reason instanceof MobilePreviewError) throw new BadRequestException(message);
    throw reason;
  }

  /**
   * docs/10 "AVD tespiti". BAĞLI CİHAZLAR da döner: uç yalnız `listAvds`'ı
   * yayınlıyordu ve o `emulator` ikilisini çağırır; ikili kurulu değilken uç
   * düşüyor ve panel "hiçbir şey yok" diyordu — oysa `adb devices` iki gerçek
   * cihaz gösteriyordu.
   *
   * AVD listelenemese bile CİHAZLAR dönülür: birinin yokluğu diğerini
   * gizlememeli.
   */
  @Get('avds')
  async avds(@Req() request: LocalSessionRequest) {
    parseLocalSession(request);
    const port = new AdbMobilePreviewPort(new MobileCommands());
    // Sebepler TUTULUR: `.catch(() => [])` ile yutmak, "hedef yok" derken
    // NEDEN olmadığını gizler — bu deponun tekrar eden kusuru.
    const failures: string[] = [];
    const attempt = async (
      name: string,
      call: () => Promise<readonly string[]>,
    ): Promise<readonly string[]> => {
      try {
        return await call();
      } catch (reason) {
        failures.push(`${name}: ${reason instanceof Error ? reason.message : String(reason)}`);
        return [];
      }
    };
    const devices = await attempt('adb devices', () => port.listDevices());
    const avds = await attempt('emulator -list-avds', () => port.listAvds());
    const targets = mobileTargets(devices, avds);
    if (!targets.available) {
      // Boş liste "her şey yolunda" der; hiçbir hedef yoksa AÇIKÇA ve
      // SEBEBİYLE söylenir.
      throw new ServiceUnavailableException(
        `emülatör hedefi yok: bağlı cihaz da başlatılabilir AVD de bulunamadı${
          failures.length === 0 ? '' : ` (${failures.join('; ')})`}`,
      );
    }
    // Geriye uyum: `avds` alanı korunur.
    return { avds: targets.avds, devices: targets.devices };
  }

  @Post('sessions')
  async open(@Req() request: LocalSessionRequest, @Body() body: { avd?: string }) {
    parseLocalSession(request);
    try {
      return await this.#service.open(body?.avd);
    } catch (reason) { return this.#unavailable(reason); }
  }

  @Get('sessions/:sessionId/frame')
  async frame(@Req() request: LocalSessionRequest, @Param('sessionId') sessionId: string) {
    parseLocalSession(request);
    try {
      const bytes = await this.#service.frame(sessionId);
      return { sessionId, pngBase64: Buffer.from(bytes).toString('base64') };
    } catch (reason) { return this.#unavailable(reason); }
  }

  /**
   * docs/11 Faz 6 "temel etkileşim". `MobilePreviewService.tap` yazılmıştı
   * ama hiçbir uç onu yayınlamıyordu: etkileşim erişilemezdi.
   */
  @Post('sessions/:sessionId/tap')
  async tap(
    @Req() request: LocalSessionRequest,
    @Param('sessionId') sessionId: string,
    @Body() body: { x?: unknown; y?: unknown },
  ) {
    parseLocalSession(request);
    const x = Number(body?.x);
    const y = Number(body?.y);
    // Koordinat doğrulaması SUNUCUDA da yapılır: panele güvenmek, bu yüzeyi
    // panelden gelen rastgele değerle host komutu çalıştırmaya açar.
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0) {
      throw new BadRequestException('dokunma koordinatı güvenli tam sayı olmalıdır');
    }
    try {
      await this.#service.tap(sessionId, x, y);
      return { sessionId, x, y };
    } catch (reason) { return this.#unavailable(reason); }
  }

  @Delete('sessions/:sessionId')
  async stop(@Req() request: LocalSessionRequest, @Param('sessionId') sessionId: string) {
    parseLocalSession(request);
    try {
      await new AdbMobilePreviewPort(new MobileCommands()).stop(sessionId);
      return { stopped: sessionId };
    } catch (reason) { return this.#unavailable(reason); }
  }
}
