import { describe, expect, it, vi } from 'vitest';
import { MobilePreviewService } from './mobile-preview.js';

describe('MobilePreviewService', () => {
  it('selects an AVD and exposes bounded frames/interactions', async () => {
    const port = { listAvds: vi.fn(async () => ['Pixel_8']), start: vi.fn(async () => ({ sessionId: 's1' })), screenshot: vi.fn(async () => new Uint8Array([1])), tap: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
    const service = new MobilePreviewService(port);
    const session = await service.open();
    expect(session.avd).toBe('Pixel_8');
    expect((await service.frame(session.sessionId)).length).toBe(1);
    await service.tap(session.sessionId, 1, 2);
  });
});
