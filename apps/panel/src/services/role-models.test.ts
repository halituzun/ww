import { describe, expect, it, vi } from 'vitest';
import { crossCheckWarnings, fetchRoleModels, saveRoleModel, type RoleModel } from './role-models.js';
import { DEFAULT_API_BASE } from './http.js';

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });

const urlOf = (mock: { mock: { calls: unknown[][] } }) =>
  (mock.mock.calls[0] as unknown as [string])[0];
const initOf = (mock: { mock: { calls: unknown[][] } }) =>
  (mock.mock.calls[0] as unknown as [string, RequestInit])[1];

const row = {
  role: 'worker', modelRef: 'deepseek:deepseek-chat',
  fallbackRefs: ['openai:gpt-5-mini'], configured: true, updatedAt: '2026-08-17T00:00:00.000Z',
};

describe('fetchRoleModels', () => {
  it('rol listesini çeker', async () => {
    const mock = vi.fn(async () => jsonResponse([row]));
    await expect(fetchRoleModels({ fetchImpl: mock as unknown as typeof fetch }))
      .resolves.toEqual([row]);
    expect(urlOf(mock)).toBe(`${DEFAULT_API_BASE}/role-models`);
  });

  it('okuma hatasında boş liste döner, paneli düşürmez', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, { status: 500 })) as unknown as typeof fetch;
    await expect(fetchRoleModels({ fetchImpl })).resolves.toEqual([]);
  });
});

describe('saveRoleModel', () => {
  it('yetkili PATCH ile kaydeder', async () => {
    const mock = vi.fn(async () => jsonResponse(row));
    await saveRoleModel('worker', 'deepseek:deepseek-chat', ['openai:gpt-5-mini'], {
      fetchImpl: mock as unknown as typeof fetch, sessionToken: 'tok',
    });
    expect(urlOf(mock)).toBe(`${DEFAULT_API_BASE}/role-models/worker`);
    expect(initOf(mock).method).toBe('PATCH');
    expect((initOf(mock).headers as Record<string, string>)['authorization']).toBe('Bearer tok');
    expect(JSON.parse(String(initOf(mock).body))).toEqual({
      modelRef: 'deepseek:deepseek-chat', fallbackRefs: ['openai:gpt-5-mini'],
    });
  });

  // Sunucu 'provider:model' bekliyor; hatalı biçimi ağa çıkmadan yakala.
  it('biçimsiz model_ref’i sunucuya göndermez', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(saveRoleModel('worker', 'bicimsiz', [], { fetchImpl }))
      .rejects.toThrow(/provider:model/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('biçimsiz yedek referansı da reddeder', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(saveRoleModel('worker', 'a:1', ['bozuk'], { fetchImpl }))
      .rejects.toThrow(/provider:model/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('boş model_ref eşlemeyi temizlemek için değil, hata için sayılır', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(saveRoleModel('worker', '   ', [], { fetchImpl })).rejects.toThrow(/provider:model/i);
  });

  it('sunucunun 400 gerekçesini yüzeye çıkarır', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      statusCode: 400, error: 'Bad Request',
    }, { status: 400 })) as unknown as typeof fetch;
    await expect(saveRoleModel('worker', 'a:1', [], { fetchImpl })).rejects.toThrow(/400/);
  });
});

describe('crossCheckWarnings', () => {
  const at = '2026-08-17T00:00:00.000Z';
  const make = (role: string, modelRef: string): RoleModel =>
    ({ role, modelRef, fallbackRefs: [], configured: modelRef !== '', updatedAt: at });

  // docs/04: verifier worker'dan FARKLI sağlayıcıdan olmalı — çapraz kontrol
  // önyargıyı kırar. Aynı sağlayıcı seçilirse denetim değeri düşer.
  it('worker ile verifier aynı sağlayıcıdaysa uyarır', () => {
    const warnings = crossCheckWarnings([
      make('worker', 'deepseek:deepseek-chat'),
      make('verifier', 'deepseek:deepseek-reasoner'),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/verifier/i);
  });

  it('farklı sağlayıcılarda uyarmaz', () => {
    expect(crossCheckWarnings([
      make('worker', 'deepseek:deepseek-chat'),
      make('verifier', 'openai:gpt-5-mini'),
    ])).toEqual([]);
  });

  it('eşlenmemiş roller için uyarı üretmez', () => {
    expect(crossCheckWarnings([make('worker', 'deepseek:x'), make('verifier', '')])).toEqual([]);
  });

  it('konseyde üç farklı sağlayıcı yoksa uyarır', () => {
    const warnings = crossCheckWarnings([make('council_member', 'deepseek:deepseek-chat')]);
    expect(warnings.some((warning) => /konsey/i.test(warning))).toBe(true);
  });
});
