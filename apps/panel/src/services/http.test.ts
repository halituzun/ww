import { describe, expect, it, vi } from 'vitest';
import { apiUrl, getJson, requestJson, DEFAULT_API_BASE } from './http.js';

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });

describe('apiUrl', () => {
  it('baseUrl verilmediğinde API kökünü kullanır (göreli yola düşmez)', () => {
    expect(apiUrl(undefined, '/projects')).toBe(`${DEFAULT_API_BASE}/projects`);
  });

  it('sondaki eğik çizgileri temizler', () => {
    expect(apiUrl('http://localhost:4000///', '/providers')).toBe('http://localhost:4000/providers');
  });
});

describe('getJson', () => {
  it('gövdeyi çözer', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ a: 1 }])) as unknown as typeof fetch;
    await expect(getJson('/projects', { fetchImpl })).resolves.toEqual([{ a: 1 }]);
  });

  it('HTML yanıtını JSON sanmaz ve nedeni söyler', async () => {
    const fetchImpl = vi.fn(async () => new Response('<!doctype html>', {
      headers: { 'content-type': 'text/html' },
    })) as unknown as typeof fetch;
    await expect(getJson('/projects', { fetchImpl })).rejects.toThrow(/JSON beklendi/i);
  });

  it('401 durumunda oturum tokenına işaret eder', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, { status: 401 })) as unknown as typeof fetch;
    await expect(getJson('/projects', { fetchImpl })).rejects.toThrow(/oturum/i);
  });

  it('diğer hata kodlarını yüzeye çıkarır', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, { status: 503 })) as unknown as typeof fetch;
    await expect(getJson('/projects', { fetchImpl })).rejects.toThrow(/503/);
  });
});

describe('requestJson', () => {
  it('yetkili yazma isteği gönderir', async () => {
    const mock = vi.fn(async () => jsonResponse({ ok: true }));
    await requestJson('/projects/p1/status', {
      method: 'PATCH',
      body: { status: 'paused' },
      fetchImpl: mock as unknown as typeof fetch,
      sessionToken: 'tok',
    });
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_API_BASE}/projects/p1/status`);
    expect(init.method).toBe('PATCH');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
    expect(JSON.parse(String(init.body))).toEqual({ status: 'paused' });
  });

  it('gövdesiz istekte content-type/body göndermez', async () => {
    const mock = vi.fn(async () => jsonResponse({ ok: true }));
    await requestJson('/ping', { method: 'POST', fetchImpl: mock as unknown as typeof fetch });
    const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBeUndefined();
  });
});
