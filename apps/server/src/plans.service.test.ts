import { describe, expect, it, vi } from 'vitest';
import { buildPlanRow, parsePlanInput } from './plans.service.js';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

describe('parsePlanInput', () => {
  it('başlık ve içeriği kabul eder', () => {
    const input = parsePlanInput({ title: 'Santranç planı', contentMd: '# Plan' });
    expect(input).toMatchObject({ title: 'Santranç planı', contentMd: '# Plan', status: 'approved' });
  });

  // Boş plan, göreve dayanak oluşturamaz.
  it('boş başlığı reddeder', () => {
    expect(() => parsePlanInput({ title: '  ', contentMd: '# Plan' })).toThrow();
  });

  it('boş içeriği reddeder', () => {
    expect(() => parsePlanInput({ title: 'x', contentMd: '' })).toThrow();
  });

  it('geçersiz durumu reddeder', () => {
    expect(() => parsePlanInput({ title: 'x', contentMd: 'y', status: 'uydurma' })).toThrow();
  });

  it('tanımlı durumu korur', () => {
    expect(parsePlanInput({ title: 'x', contentMd: 'y', status: 'proposed' }).status).toBe('proposed');
  });
});

describe('buildPlanRow', () => {
  const base = {
    projectId: id(1) as never,
    planId: id(2) as never,
    agentId: id(3) as never,
    now: '2026-08-17T09:00:00.000Z',
  };

  it('projeye bağlı satır kurar', () => {
    const row = buildPlanRow(base, parsePlanInput({ title: 'Plan', contentMd: '# içerik' }));
    expect(row).toMatchObject({
      project_id: id(1), plan_id: id(2), title: 'Plan',
      content_md: '# içerik', status: 'approved', plan_version: 1,
    });
  });

  // Planı kimin ürettiği izlenemezse "bu kararı kim aldı" sorusu cevapsız kalır.
  it('üreten agent’ı kaydeder', () => {
    const row = buildPlanRow(base, parsePlanInput({ title: 'Plan', contentMd: 'x' }));
    expect(row.created_by_agent_id).toBe(id(3));
    expect(row.created_at).toBe('2026-08-17T09:00:00.000Z');
  });

  it('JSON alanlarını dizi olarak başlatır', () => {
    const row = buildPlanRow(base, parsePlanInput({ title: 'Plan', contentMd: 'x' }));
    expect(row.team_json).toEqual([]);
    expect(row.scenarios_json).toEqual([]);
  });
});

const unused = vi;
void unused;
