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

  @Get('avds')
  async avds(@Req() request: LocalSessionRequest) {
    parseLocalSession(request);
    try {
      return { avds: await new AdbMobilePreviewPort(new MobileCommands()).listAvds() };
    } catch (reason) { return this.#unavailable(reason); }
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

  @Delete('sessions/:sessionId')
  async stop(@Req() request: LocalSessionRequest, @Param('sessionId') sessionId: string) {
    parseLocalSession(request);
    try {
      await new AdbMobilePreviewPort(new MobileCommands()).stop(sessionId);
      return { stopped: sessionId };
    } catch (reason) { return this.#unavailable(reason); }
  }
}
