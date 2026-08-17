import { describe, expect, it } from 'vitest';
import { resolveRuntimeModels, resolveWorkspaceRoot } from './runtime-context.js';
import type { RoutingIndex } from '@ww/providers';

const routing = (map: Record<string, string>): RoutingIndex => ({
  modelForRole: (role) => map[role],
  fallbacks: () => [],
});

describe('resolveRuntimeModels', () => {
  it('worker ve verifier modellerini rol eşlemesinden çözer', () => {
    const models = resolveRuntimeModels(routing({
      worker: 'deepseek:deepseek-chat',
      verifier: 'openai:gpt-5-mini',
    }));
    expect(models).toEqual({
      workerModelRef: 'deepseek:deepseek-chat',
      verifierModelRef: 'openai:gpt-5-mini',
    });
  });

  // Eşleme yoksa sessizce bir varsayılana düşmek, kullanıcının seçmediği bir
  // modelle para harcamak demektir. Fail-closed davranış doğrusudur.
  it('worker eşlemesi yoksa açık hata verir', () => {
    expect(() => resolveRuntimeModels(routing({ verifier: 'a:b' })))
      .toThrow(/worker/i);
  });

  it('verifier eşlemesi yoksa açık hata verir', () => {
    expect(() => resolveRuntimeModels(routing({ worker: 'a:b' })))
      .toThrow(/verifier/i);
  });

  // docs/04: verifier worker'dan farklı sağlayıcıdan olmalı. Engelleyici
  // değil ama sessiz de olmamalı; çağıran uyarıyı görebilmeli.
  it('aynı sağlayıcı kullanıldığında uyarı üretir', () => {
    const models = resolveRuntimeModels(routing({
      worker: 'deepseek:deepseek-chat',
      verifier: 'deepseek:deepseek-reasoner',
    }));
    expect(models.warning).toMatch(/çapraz kontrol|aynı sağlayıcı/i);
  });

  it('farklı sağlayıcılarda uyarı üretmez', () => {
    const models = resolveRuntimeModels(routing({
      worker: 'deepseek:deepseek-chat',
      verifier: 'openai:gpt-5-mini',
    }));
    expect(models.warning).toBeUndefined();
  });
});

describe('resolveWorkspaceRoot', () => {
  it('proje slug’ını workspace kökü altına yerleştirir', () => {
    expect(resolveWorkspaceRoot('/srv/ww/workspace', 'satranc'))
      .toBe('/srv/ww/workspace/satranc');
  });

  // Yol kaçışı sandbox sınırını deler: proje kendi klasörünün dışına yazamaz.
  it('yol kaçışı denemesini reddeder', () => {
    expect(() => resolveWorkspaceRoot('/srv/ww/workspace', '../etc')).toThrow(/slug/i);
    expect(() => resolveWorkspaceRoot('/srv/ww/workspace', 'a/b')).toThrow(/slug/i);
    expect(() => resolveWorkspaceRoot('/srv/ww/workspace', '')).toThrow(/slug/i);
  });

  it('mutlak olmayan kökü reddeder', () => {
    expect(() => resolveWorkspaceRoot('workspace', 'satranc')).toThrow(/mutlak/i);
  });
});
