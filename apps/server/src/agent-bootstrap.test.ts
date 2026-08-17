import { describe, expect, it } from 'vitest';
import { BOOTSTRAP_AGENTS, bootstrapPromptName, planBootstrapPrompts } from './agent-bootstrap.js';

const projectId = '00000000-0000-4000-8000-000000000001';

describe('bootstrapPromptName', () => {
  it('proje ve role göre benzersiz ad üretir', () => {
    expect(bootstrapPromptName(projectId, 'worker')).toBe(`bootstrap.${projectId}.worker`);
  });
});

describe('planBootstrapPrompts', () => {
  const canonical = new Map([
    ['role.pm', { prompt_name: 'role.pm', prompt_version: 2, content: 'PM içeriği' }],
    ['role.worker.coding', { prompt_name: 'role.worker.coding', prompt_version: 2, content: 'Worker içeriği' }],
    ['role.verifier', { prompt_name: 'role.verifier', prompt_version: 1, content: 'Verifier içeriği' }],
  ]);

  // ASIL KUSUR: agent'lar var olmayan prompta işaret ediyordu; brief mühürleme
  // 'as-of prompt bulunamadi' ile düşüyor ve HİÇBİR görev koşamıyordu.
  it('her bootstrap agent’ı için bir prompt satırı planlar', () => {
    const prompts = planBootstrapPrompts(projectId, canonical as never);
    expect(prompts).toHaveLength(BOOTSTRAP_AGENTS.length);
    expect(prompts.map((prompt) => prompt.prompt_name)).toEqual(
      BOOTSTRAP_AGENTS.map((agent) => bootstrapPromptName(projectId, agent.role)),
    );
  });

  it('içeriği kanonik rol promptundan kopyalar', () => {
    const prompts = planBootstrapPrompts(projectId, canonical as never);
    const worker = prompts.find((prompt) => prompt.prompt_name.endsWith('.worker'));
    expect(worker?.content).toBe('Worker içeriği');
  });

  // Sürüm 1'de sabitlenir: agent satırı prompt_version=1 taşır, uyuşmazsa
  // yine sarkan referans olur.
  it('sürümü agent satırıyla aynı tutar', () => {
    for (const prompt of planBootstrapPrompts(projectId, canonical as never)) {
      expect(prompt.prompt_version).toBe(1);
    }
  });

  it('promptları aktif işaretler', () => {
    for (const prompt of planBootstrapPrompts(projectId, canonical as never)) {
      expect(prompt.is_active).toBe(true);
    }
  });

  it('hangi kanonik kaynaktan türediğini kaydeder', () => {
    const prompts = planBootstrapPrompts(projectId, canonical as never);
    const verifier = prompts.find((prompt) => prompt.prompt_name.endsWith('.verifier'));
    expect(verifier?.changelog).toContain('role.verifier');
  });

  // Sessizce boş içerikli prompt üretmek, modeli talimatsız çalıştırmaktır.
  it('kanonik prompt eksikse açık hata verir', () => {
    const missing = new Map([['role.pm', { prompt_name: 'role.pm', prompt_version: 1, content: 'x' }]]);
    expect(() => planBootstrapPrompts(projectId, missing as never)).toThrow(/role\.worker\.coding/);
  });
});
