import { describe, expect, it } from 'vitest';
import { processLifecycleEvent } from './process-event.js';

const base = {
  projectId: '00000000-0000-4000-8000-000000000001',
  kind: 'dev' as const,
  occurredAt: '2026-08-18T09:00:00.000Z',
};

describe('processLifecycleEvent (docs/10 → Ortak Davranışlar)', () => {
  it('baslatma olayini uretir', () => {
    const row = processLifecycleEvent({ ...base, state: 'started', port: 42001 });
    expect(row.event_type).toBe('process_started');
    expect(row.project_id).toBe(base.projectId);
    expect(row.payload).toMatchObject({ kind: 'dev', port: 42001 });
  });

  it('durdurma olayini uretir', () => {
    expect(processLifecycleEvent({ ...base, state: 'stopped' }).event_type)
      .toBe('process_stopped');
  });

  // Aynı olayın iki kez yazılması zaman çizelgesini şişirir; kimlik
  // içerikten TÜRETİLİR ki tekrar denemede aynı satır oluşsun.
  it('ayni girdi icin ayni kimligi uretir', () => {
    const a = processLifecycleEvent({ ...base, state: 'started', port: 42001 });
    const b = processLifecycleEvent({ ...base, state: 'started', port: 42001 });
    expect(a.event_id).toBe(b.event_id);
    expect(String(a.event_id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('farkli durumlar farkli kimlik alir', () => {
    const started = processLifecycleEvent({ ...base, state: 'started', port: 1 });
    const stopped = processLifecycleEvent({ ...base, state: 'stopped', port: 1 });
    expect(started.event_id).not.toBe(stopped.event_id);
  });

  // Yük NESNE olarak yazılır; JSON metni çift kodlamaya yol açar (bkz.
  // events.payload koruması).
  it('yuku nesne olarak verir', () => {
    expect(typeof processLifecycleEvent({ ...base, state: 'started' }).payload)
      .toBe('object');
  });

  // ÇÖKME de bir durmadır ve sebebiyle yazılır: "durdu" ile "çöktü" ayrımını
  // zaman çizelgesinde okuyabilmek için sebep şart.
  it('cokme sebebini yuke koyar', () => {
    const row = processLifecycleEvent({
      ...base, state: 'stopped', port: 42001, reason: 'exit:137',
    });
    expect(row.event_type).toBe('process_stopped');
    expect(row.payload).toMatchObject({ reason: 'exit:137' });
  });

  it('sebep verilmezse alan HIC olusmaz', () => {
    const payload = processLifecycleEvent({ ...base, state: 'stopped' }).payload;
    expect(Object.keys(payload)).not.toContain('reason');
  });
});
