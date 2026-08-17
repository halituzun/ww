import { describe, expect, it, vi } from 'vitest';
import { brakeLabel, fetchAuditReport, severityTone, EMPTY_AUDIT_REPORT } from './audit.js';
import { DEFAULT_API_BASE } from './http.js';

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });

describe('fetchAuditReport', () => {
  it('denetim raporunu çeker', async () => {
    const report = { ...EMPTY_AUDIT_REPORT, projectId: 'p1', brakeTrips: 2 };
    const mock = vi.fn(async () => jsonResponse(report));
    await expect(fetchAuditReport('p1', { fetchImpl: mock as unknown as typeof fetch }))
      .resolves.toEqual(report);
    expect((mock.mock.calls[0] as unknown as [string])[0])
      .toBe(`${DEFAULT_API_BASE}/projects/p1/audit`);
  });

  it('okuma hatasında boş rapor döner', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, { status: 503 })) as unknown as typeof fetch;
    await expect(fetchAuditReport('p1', { fetchImpl })).resolves.toEqual(EMPTY_AUDIT_REPORT);
  });
});

describe('brakeLabel', () => {
  it('dört fren türünü de Türkçeleştirir', () => {
    expect(brakeLabel('cost_budget')).toMatch(/bütçe/i);
    expect(brakeLabel('token_budget')).toMatch(/token/i);
    expect(brakeLabel('wall_clock')).toMatch(/süre/i);
    expect(brakeLabel('loop_similarity')).toMatch(/döngü/i);
  });

  it('fren olmayan tırmandırmayı fren gibi adlandırmaz', () => {
    expect(brakeLabel('')).toBe('Tırmandırma');
  });

  it('bilinmeyen türü kaybetmez', () => {
    expect(brakeLabel('yeni_fren')).toContain('yeni_fren');
  });
});

describe('severityTone', () => {
  it('önem derecesini tona çevirir', () => {
    expect(severityTone('critical')).toBe('critical');
    expect(severityTone('medium')).toBe('warning');
    expect(severityTone('low')).toBe('neutral');
  });
});
