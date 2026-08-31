import { describe, expect, it } from 'vitest';
import type { OrgPlan } from '@ww/shared';
import { planOrgRoster, rosterCanonicalPromptNames, rosterPromptName } from './agent-roster.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';

const orgPlan: OrgPlan = {
  departments: [
    {
      id: 'dept-ui',
      name: 'Arayüz',
      group: 'design',
      lead_role: 'group_lead',
      members: [
        { role: 'worker', count: 2, model_tier: 'medium' },
        { role: 'verifier', count: 1, model_tier: 'medium' },
      ],
      responsibility_patterns: ['src/views/**'],
      rationale: 'arayüz',
    },
    {
      id: 'dept-core',
      name: 'Çekirdek',
      group: 'coding',
      lead_role: 'group_lead',
      members: [{ role: 'worker', count: 1, model_tier: 'heavy' }],
      responsibility_patterns: ['src/core/**'],
      rationale: 'çekirdek',
    },
  ],
  non_department_roles: [
    { role: 'pm', reports_to: 'user', rationale: 'yönetim' },
    { role: 'standards_auditor', reports_to: 'pm', rationale: 'denetim' },
  ],
  concurrency_limit: 2,
  estimated_tokens: 1,
  estimated_cost_usd: 1,
} as OrgPlan;

const canonicalFor = (names: readonly string[]) =>
  new Map(names.map((name) => [name, { prompt_name: name, prompt_version: 1, content: `${name} icerigi` }]));

const allCanonical = () => canonicalFor(rosterCanonicalPromptNames(orgPlan));

describe('org planı kadrosu', () => {
  it('departman liderlerini ve üyelerini üretir', () => {
    const roster = planOrgRoster({
      projectId: PROJECT,
      orgPlan,
      existingAgentNames: new Set(),
      canonical: allCanonical(),
    });

    expect(roster.missingPrompts).toEqual([]);
    // NEDEN group_lead özellikle aranıyor: bu rol hiç doğmadığı için
    // docs/13'ün group_lead ve professor tırmandırma basamakları
    // erişilemez kalıyordu.
    expect(roster.agents.filter((a) => a.role === 'group_lead')).toHaveLength(2);
    expect(roster.agents.filter((a) => a.role === 'worker')).toHaveLength(3);
    expect(roster.agents.filter((a) => a.role === 'verifier')).toHaveLength(1);
    expect(roster.agents.some((a) => a.role === 'standards_auditor')).toBe(true);
  });

  it('worker promptunu departman grubuna göre ayırır', () => {
    const roster = planOrgRoster({
      projectId: PROJECT,
      orgPlan,
      existingAgentNames: new Set(),
      canonical: allCanonical(),
    });

    const designWorker = roster.agents.find((a) => a.role === 'worker' && a.group === 'design');
    const codingWorker = roster.agents.find((a) => a.role === 'worker' && a.group === 'coding');
    // Bootstrap şeması promptu ROLE göre adlandırıyor; iki grubun worker'ı
    // aynı ada düşer ve tasarım worker'ı kodlama promptu alırdı.
    expect(designWorker?.promptName).toBe(rosterPromptName(PROJECT, 'role.worker.design'));
    expect(codingWorker?.promptName).toBe(rosterPromptName(PROJECT, 'role.worker.coding'));
    expect(designWorker?.promptName).not.toBe(codingWorker?.promptName);
  });

  it('aynı prompt için tek satır yazar', () => {
    const roster = planOrgRoster({
      projectId: PROJECT,
      orgPlan,
      existingAgentNames: new Set(),
      canonical: allCanonical(),
    });
    const names = roster.prompts.map((p) => p.prompt_name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('var olan agentı çoğaltmaz (idempotent)', () => {
    const full = planOrgRoster({
      projectId: PROJECT,
      orgPlan,
      existingAgentNames: new Set(),
      canonical: allCanonical(),
    });
    const again = planOrgRoster({
      projectId: PROJECT,
      orgPlan,
      existingAgentNames: new Set(full.agents.map((a) => a.name)),
      canonical: allCanonical(),
    });
    expect(again.agents).toHaveLength(0);
    expect(again.prompts).toHaveLength(0);
  });

  it('eksik kanonik promptu sessizce atlamaz, bildirir', () => {
    const roster = planOrgRoster({
      projectId: PROJECT,
      orgPlan,
      existingAgentNames: new Set(),
      // group_lead promptu kasten yok.
      canonical: canonicalFor(
        rosterCanonicalPromptNames(orgPlan).filter((n) => n !== 'role.group_lead'),
      ),
    });
    expect(roster.missingPrompts).toContain('role.group_lead');
    expect(roster.agents.some((a) => a.role === 'group_lead')).toBe(false);
  });
});
