// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { AuditPanel } from './AuditPanel.js';
import { EMPTY_AUDIT_REPORT, type AuditReport } from '../services/audit.js';

afterEach(cleanup);

const report = (over: Partial<AuditReport> = {}): AuditReport => ({
  ...EMPTY_AUDIT_REPORT, projectId: 'p1', ...over,
});

const mount = (value: AuditReport) => render(
  <AuditPanel projectId="p1" ports={{ fetchReport: vi.fn(async () => value), pollMs: 60_000 }} />,
);

describe('AuditPanel', () => {
  it('acik bulgu sayisini gosterir', async () => {
    mount(report({ counts: { open: 3, correction_pending: 0, resolved: 1, dismissed: 0 } }));
    await waitFor(() => expect(screen.getByText('3')).toBeTruthy());
  });

  // Bu oturumda eklenen REC bulguları buraya akıyor. Ekran onları
  // göstermezse, denetçinin bulduğu her şey GÖRÜNMEZ kalır.
  it('kayit eksiklerini gosterir', async () => {
    mount(report({
      recordFindings: [{
        ruleId: 'REC-004', taskId: 't1', severity: 'high',
        summary: '"Renk yardımcısı" görevi plansız kuyrukta: atanamaz ve hiç çalışmaz.',
      }],
    }));
    await waitFor(() => expect(screen.getByText(/plansız kuyrukta/)).toBeTruthy());
    expect(screen.getByText('Plansız: hiç çalışamaz')).toBeTruthy();
  });

  it('tirmandirmalari ve fren sayisini gosterir', async () => {
    mount(report({
      escalations: [{
        eventId: 'e1', taskId: 't1', reason: 'bütçe aşıldı',
        brakeKind: 'cost_budget', createdAt: '2026-08-18T09:00:00.000Z',
      }],
      brakeTrips: 1,
    }));
    await waitFor(() => expect(screen.getByText(/bütçe aşıldı/)).toBeTruthy());
  });

  // docs/09 ui_audit: hata durumu tasarlanmış olmalı. Sessizce boş ekran,
  // "denetim temiz" yalanını söyler.
  it('rapor alinamazsa hatayi gosterir, temiz gibi davranmaz', async () => {
    render(<AuditPanel projectId="p1" ports={{
      fetchReport: vi.fn(async () => { throw new Error('denetim alınamadı'); }),
      pollMs: 60_000,
    }} />);
    await waitFor(() => expect(screen.getByText(/denetim alınamadı/)).toBeTruthy());
  });
});
