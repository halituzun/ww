import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ZodExceptionFilter } from './zod-exception.filter.js';

function hostFor() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as Parameters<ZodExceptionFilter['catch']>[1];
  return { host, status, json };
}

describe('ZodExceptionFilter', () => {
  it('doğrulama hatasını 500 değil 400 yapar', () => {
    const { host, status, json } = hostFor();
    const error = (() => {
      try {
        z.strictObject({ name: z.string().min(1) }).parse({ name: '' });
        throw new Error('beklenen hata atılmadı');
      } catch (reason) { return reason as z.ZodError; }
    })();

    new ZodExceptionFilter().catch(error, host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 400,
      error: 'Bad Request',
    }));
  });

  it('hangi alanın neden reddedildiğini yanıtta bildirir', () => {
    const { host, json } = hostFor();
    const error = (() => {
      try {
        z.strictObject({ modelRef: z.string().regex(/^[a-z]+:[a-z]+$/) }).parse({ modelRef: 'bicimsiz' });
        throw new Error('beklenen hata atılmadı');
      } catch (reason) { return reason as z.ZodError; }
    })();

    new ZodExceptionFilter().catch(error, host);

    const payload = json.mock.calls[0]![0] as { details: { fieldErrors: Record<string, unknown> } };
    expect(payload.details.fieldErrors).toHaveProperty('modelRef');
  });

  // Sır sızıntısı riski: doğrulama hatası ham gövdeyi geri yansıtmamalı.
  it('gönderilen değeri yanıta yansıtmaz', () => {
    const { host, json } = hostFor();
    const error = (() => {
      try {
        z.strictObject({ apiKey: z.string().min(100) }).parse({ apiKey: 'sk-gercek-gizli-anahtar' });
        throw new Error('beklenen hata atılmadı');
      } catch (reason) { return reason as z.ZodError; }
    })();

    new ZodExceptionFilter().catch(error, host);

    expect(JSON.stringify(json.mock.calls[0]![0])).not.toContain('sk-gercek-gizli-anahtar');
  });
});
