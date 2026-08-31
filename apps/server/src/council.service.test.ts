    const plans: unknown[] = [];
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildCouncilTurnPrompt, councilMessageForTurn, CouncilApplicationService } from './council.service.js';
import type { ServerDatabase } from './orchestration.module.js';

describe('CouncilApplicationService — 5 Tur ve Org Plan (Faz D)', () => {
  it('5 turluk müzakereyi ve org_plan çıktısını başarıyla üretir', async () => {
    const sentTurns: Array<{ turnNumber: number; kind: string; text: string }> = [];

    const fakeCh = {
      query: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
        if (query.includes('FROM projects')) {
          return { json: async () => [{
            project_id: '00000000-0000-4000-8000-000000000001',
            name: 'Tetris Web Oyunu',
            type: 'web',
            slug: 'tetris-web-oyunu',
            description: 'Tetris oyunu',
            status: 'planning',
            active_plan_id: '00000000-0000-0000-0000-000000000000',
            repo_path: '/tmp/tetris',
            workspace_path: '/tmp/tetris',
            runtime_port: 3000,
            preview_url: '',
            brief: 'Tetris oyunu',
            budget_usd_limit: 100,
            settings: '{}',
            version: 1,
            base_branch: 'main',
            work_branch: 'work',
            created_at: '2026-08-27 10:00:00.000',
            updated_at: '2026-08-27 10:00:00.000',
          }] };
        }
        if (query.includes('FROM role_models')) {
          return { json: async () => [] };
        }
        if (query.includes('FROM api_providers')) {
          return { json: async () => [{
            provider_id: 'ollama',
            display_name: 'Provider 1',
            base_url: 'http://loc',
            enabled: true,
            is_default: true,
            fallback_order: 1,
            models: ['qwen3.6', 'deepseek-33b', 'mistral-large'],
            key_ref: 'k1',
            health_status: 'ok',
            last_health_check: '2026-08-27 10:00:00.000',
            updated_at: '2026-08-27 10:00:00.000',
            version: 1,
          }] };
        }
        if (query.includes('FROM agents')) {
          return { json: async () => [
            {
              agent_id: '11111111-1111-4111-8111-111111111111',
              project_id: '00000000-0000-4000-8000-000000000001',
              role: 'council_member',
              group: 'management',
              name: 'Konsey 1',
              model_ref: 'ollama:qwen3.6',
              parent_agent_id: '00000000-0000-0000-0000-000000000000',
              clone_of: '00000000-0000-0000-0000-000000000000',
              status: 'idle',
              current_task_id: '00000000-0000-0000-0000-000000000000',
              prompt_name: 'role.council',
              prompt_version: 1,
              tasks_done: 0,
              tasks_rejected: 0,
              created_at: '2026-08-27 10:00:00.000',
              updated_at: '2026-08-27 10:00:00.000',
              version: 1,
            },
            {
              agent_id: '22222222-2222-4222-8222-222222222222',
              project_id: '00000000-0000-4000-8000-000000000001',
              role: 'council_member',
              group: 'management',
              name: 'Konsey 2',
              model_ref: 'ollama:deepseek-33b',
              parent_agent_id: '00000000-0000-0000-0000-000000000000',
              clone_of: '00000000-0000-0000-0000-000000000000',
              status: 'idle',
              current_task_id: '00000000-0000-0000-0000-000000000000',
              prompt_name: 'role.council',
              prompt_version: 1,
              tasks_done: 0,
              tasks_rejected: 0,
              created_at: '2026-08-27 10:00:00.000',
              updated_at: '2026-08-27 10:00:00.000',
              version: 1,
            },
            {
              agent_id: '33333333-3333-4333-8333-333333333333',
              project_id: '00000000-0000-4000-8000-000000000001',
              role: 'council_member',
              group: 'management',
              name: 'Konsey 3',
              model_ref: 'ollama:mistral-large',
              parent_agent_id: '00000000-0000-0000-0000-000000000000',
              clone_of: '00000000-0000-0000-0000-000000000000',
              status: 'idle',
              current_task_id: '00000000-0000-0000-0000-000000000000',
              prompt_name: 'role.council',
              prompt_version: 1,
              tasks_done: 0,
              tasks_rejected: 0,
              created_at: '2026-08-27 10:00:00.000',
              updated_at: '2026-08-27 10:00:00.000',
              version: 1,
            },
          ] };
        }
        if (query.includes('plans') || query.includes('plan_mutations')) {
          const list = query_params?.planId ? plans.filter(p => p.plan_id === query_params.planId) : plans;
          return { json: async () => list.map(p => ({
            plan_id: p.plan_id,
            project_id: p.project_id,
            plan_version: p.plan_version ?? 1,
            status: p.status ?? 'draft',
            title: p.title,
            content_md: p.content_md,
            council_session_id: p.council_session_id,
            team_json: typeof p.team_json === 'string' ? p.team_json : JSON.stringify(p.team_json),
            scenarios_json: typeof p.scenarios_json === 'string' ? p.scenarios_json : JSON.stringify(p.scenarios_json),
            replan_reason: p.replan_reason ?? '',
            supersedes_plan_id: p.supersedes_plan_id ?? '00000000-0000-0000-0000-000000000000',
            created_by_agent_id: p.created_by_agent_id,
            approved_by: p.approved_by ?? '',
            created_at: p.created_at,
            updated_at: p.updated_at,
            version: 1,
          })) };
        }
        return { json: async () => [] };
      },
      insert: async ({ values }: { values?: readonly unknown[] }) => {
        if (values) plans.push(...values);
      },
      command: async ({ query_params }: { query_params?: Record<string, unknown> }) => {
        if (query_params) {
          plans.push({
            plan_id: query_params.planId,
            project_id: query_params.projectId,
            plan_version: query_params.planVersion ?? 1,
            status: query_params.status ?? 'draft',
            title: query_params.title ?? '',
            content_md: query_params.contentMd ?? '',
            council_session_id: query_params.councilSessionId,
            team_json: query_params.teamJson,
            scenarios_json: query_params.scenariosJson,
            replan_reason: query_params.replanReason ?? '',
            supersedes_plan_id: query_params.supersedesPlanId,
            created_by_agent_id: query_params.createdByAgentId,
            approved_by: query_params.approvedBy ?? '',
            created_at: query_params.createdAt,
            updated_at: query_params.createdAt,
            version: query_params.version ?? 1,
          });
        }
      },
    };

    const fakeTransport = async (turn: { turnNumber: number; kind: string; text: string }) => {
      sentTurns.push({ turnNumber: turn.turnNumber, kind: turn.kind, text: turn.text });
      return { messageId: randomUUID() };
    };

    // redis yolu bu testte hiç kullanılmıyor; `as unknown as` ile susturmak
    // yerine eksikliği açıkça yazıyoruz. Redis'e dokunan bir yol eklenirse
    // test derlenmeyi bırakmalı ki gap görünür kalsın.
    const database = { ch: fakeCh } as unknown as ServerDatabase;
    const service = new CouncilApplicationService(database, fakeTransport);

    const result = await service.run('00000000-0000-4000-8000-000000000001', 'Tetris web oyunu geliştir', async ({ kind }) => ({ text: `${kind} gerekçeli müzakere cevabı` }));

    expect(result.planId).toBeDefined();
    expect(result.sessionId).toBeDefined();
    // 3 üye x Tur 1 (3) + 3 üye x Tur 2 (3) + Tur 3 (1) + Tur 4 (1) + Tur 5 (1) = 9 tur
    expect(result.turns).toBe(9);
    expect(result.orgPlan).toBeDefined();
    expect(result.orgPlan.departments).toHaveLength(2); // Tetris -> 2 departman
    expect(result.orgPlan.concurrency_limit).toBe(2);
    expect(sentTurns.map(t => t.kind)).toContain('proposal');
    expect(sentTurns.map(t => t.kind)).toContain('objection');
    expect(sentTurns.map(t => t.kind)).toContain('draft_synthesis');
    expect(sentTurns.map(t => t.kind)).toContain('red_team');
    expect(sentTurns.map(t => t.kind)).toContain('final_synthesis');
  });
});


describe('Türkçe Karakter ve Emoji Filtre Doğrulaması', () => {
  it('Görüşmeci çalışıyor, ağırlık şüphesi metnini Latin-Extended karakterleriyle birebir korur', () => {
    const raw = 'Görüşmeci çalışıyor, ağırlık şüphesi 🚀 ⚠️ 💡';
    // SADECE emoji/dingbat blokları (U+1F300–1FAFF, U+2600–27BF, U+FE0F, U+200D)
    const cleaned = raw.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '').replace(/[ \t]+/g, ' ').trim();
    expect(cleaned).toBe('Görüşmeci çalışıyor, ağırlık şüphesi');
  });

  it('Tüm Türkçe özel karakterlerini (ç, ğ, ı, ö, ş, ü, İ, Ç, Ğ, Ö, Ş, Ü) bozulmadan korur', () => {
    const trText = 'ÇŞĞÜÖIİ çşğüöı - Gerçek Türkçe metin ve mimari itirazlar.';
    const cleaned = trText.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '').trim();
    expect(cleaned).toBe(trText);
  });
});

describe('Tur 5 Dil ve Şablon Doğrulaması (Epistemik Dürüstlük)', () => {
  it('araştırma ve ek müzakere turlarını task report invariantına sokmadan provenance ile taşır', () => {
    expect(councilMessageForTurn({ kind: 'research', text: 'Araştırma sonucu' })).toEqual({
      kind: 'proposal',
      payload: { type: 'proposal', markdown: 'Araştırma sonucu' },
    });
    expect(councilMessageForTurn({ kind: 'debate_round', text: 'Ek müzakere' })).toEqual({
      kind: 'proposal',
      payload: { type: 'proposal', markdown: 'Ek müzakere' },
    });
  });

  it('oyun projesi Tur 4 ve Tur 5 promptlarına hesap makinesi örnek bulgusu gömmez', () => {
    const goal = 'Tamamen çevrimdışı çalışan VE canlı çok oyunculu küresel anlık skor tablosu olan web oyunu geliştir.';
    const prior = [
      {
        memberId: '11111111-1111-4111-8111-111111111111' as never,
        kind: 'draft_synthesis' as const,
        turnNumber: 3,
        turnTitle: 'Tur 3 · Birleşik Taslak',
        text: 'HTML5 oyun, offline önbellek ve canlı skor için seçenekler tartışılıyor.',
        evidenceRefs: [],
      },
      {
        memberId: '22222222-2222-4222-8222-222222222222' as never,
        kind: 'red_team' as const,
        turnNumber: 4,
        turnTitle: 'Tur 4 · Kırmızı Takım',
        text: 'Çevrimdışı çalışma ile canlı skor tablosu aynı anda mutlak garanti edilemez.',
        evidenceRefs: [],
      },
    ];

    const redPrompt = buildCouncilTurnPrompt('red_team', goal, prior.slice(0, 1));
    const finalPrompt = buildCouncilTurnPrompt('final_synthesis', goal, prior);

    expect(`${redPrompt}\n${finalPrompt}`).toContain('çevrimdışı');
    expect(`${redPrompt}\n${finalPrompt}`).toContain('canlı');
    expect(`${redPrompt}\n${finalPrompt}`).not.toMatch(/0\.1 \+ 0\.2|IEEE 754|eval\/regex|Matematik Motoru/i);
  });

  it('Hesap makinesi gibi küçük projeler için deriveOrgPlan tam 2 departman üretir', async () => {
    const { deriveOrgPlan } = await import("./council-plan.js");
    const plan = deriveOrgPlan("Hesap Makinesi Projesi", "Kullanıcıların basit hesaplamalar yapabileceği web tabanlı hesap makinesi");
    expect(plan.departments).toHaveLength(2);
    expect(plan.concurrency_limit).toBe(2);
    expect(plan.departments[0].name).toContain("Arayüz");
    expect(plan.departments[1].name).toContain("Motor");
  });

  it('Tur 5 nihai karar şablonu BULGU, KARAR, GEREKÇE ve PLANA YANSIMASI alanlarını eksiksiz içerir', () => {
    const sampleOutput = `BULGU 1: Çevrimdışı çalışma ile canlı skor tablosu çelişkisi
KARAR: KABUL
GEREKÇE: Gerçek zamanlı küresel skor için ağ gerekir; tam çevrimdışı modda yalnız yerel skor garanti edilebilir.
PLANA YANSIMASI: Canlı skor opsiyonel çevrimiçi mod, çevrimdışı skor ise yerel kayıt olarak ayrıldı.

BULGU 2: Kapsam şişmesi
KARAR: KABUL
GEREKÇE: Basit web oyunu için mobil uygulama ve ayrı sunucu zorunlu değildir.
PLANA YANSIMASI: İlk plan HTML5/CSS/JS ve local-first kayıtla sınırlandı.

BULGU 3: Test stratejisi eksikliği
KARAR: KABUL
GEREKÇE: Çevrimdışı/çevrimiçi geçişleri ayrı kabul kriteri olmadan doğrulanamaz.
PLANA YANSIMASI: Offline skor, bağlantı gelince eşitleme ve hata durumları test kapsamına eklendi.

NİHAİ DEPARTMANLAR:
1. Departman: Oyun Mantığı ve Yerel Kayıt
2. Departman: Kullanıcı Arayüzü ve Kalite Güvence`;

    expect(sampleOutput).toContain("BULGU 1:");
    expect(sampleOutput).toContain("BULGU 2:");
    expect(sampleOutput).toContain("BULGU 3:");
    expect(sampleOutput).toContain("KARAR: KABUL");
    expect(sampleOutput).toContain("PLANA YANSIMASI:");
    expect(sampleOutput).not.toMatch(/\b(based on|the team|provided information)\b/i);
  });
});
