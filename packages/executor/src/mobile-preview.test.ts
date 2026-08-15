import { describe, expect, it, vi } from 'vitest';
import { AdbMobilePreviewPort, MobilePreviewService } from './mobile-preview.js';

describe('MobilePreviewService', () => {
  it('selects an AVD and exposes bounded frames/interactions', async () => {
    const port = { listAvds: vi.fn(async () => ['Pixel_8']), start: vi.fn(async () => ({ sessionId: 's1' })), screenshot: vi.fn(async () => new Uint8Array([1])), tap: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
    const service = new MobilePreviewService(port);
    const session = await service.open();
    expect(session.avd).toBe('Pixel_8');
    expect((await service.frame(session.sessionId)).length).toBe(1);
    await service.tap(session.sessionId, 1, 2);
  });

  it('ADB adapterı yalnız injected komut portundan çalışır ve yaşam döngüsünü kapatır', async () => {
    const calls: string[][] = [];
    let stopped = false;
    const port = new AdbMobilePreviewPort({
      run: async (command, args) => { calls.push([command, ...args]); if (args[0] === '-list-avds') return { stdout: 'Pixel_8\n' }; if (args.includes('screencap')) return { stdout: '', bytes: new Uint8Array([137, 80]) }; return { stdout: '' }; },
      start: async () => ({ sessionId: 'emu-1', stop: async () => { stopped = true; } }),
    });
    expect(await port.listAvds()).toEqual(['Pixel_8']);
    const session = await port.start('Pixel_8');
    expect((await port.screenshot(session.sessionId)).length).toBe(2);
    await port.tap(session.sessionId, 10, 20);
    await port.stop(session.sessionId);
    expect(stopped).toBe(true);
    expect(calls).toContainEqual(['adb', '-s', 'emu-1', 'shell', 'input', 'tap', '10', '20']);
  });
});
