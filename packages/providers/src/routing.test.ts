import { describe, expect, it } from 'vitest';
import { buildRoutingIndex, type RoleModelEntry, type RoutingProvider } from './routing.js';

const role = (r: string, modelRef: string, fallbackRefs: string[] = []): RoleModelEntry =>
  ({ role: r, modelRef, fallbackRefs });

const provider = (id: string, over: Partial<RoutingProvider> = {}): RoutingProvider =>
  ({ providerId: id, enabled: true, isDefault: false, models: [`${id}-model`], ...over });

describe('buildRoutingIndex', () => {
  it('rolü modeline eşler', () => {
    const index = buildRoutingIndex([role('worker', 'deepseek:chat')], [provider('deepseek')]);
    expect(index.modelForRole('worker')).toBe('deepseek:chat');
  });

  it('eşlenmemiş rol için undefined döner', () => {
    const index = buildRoutingIndex([], [provider('deepseek')]);
    expect(index.modelForRole('worker')).toBeUndefined();
  });

  it('rolün yedeklerini fallback zincirine koyar', () => {
    const index = buildRoutingIndex(
      [role('worker', 'deepseek:chat', ['openai:mini'])],
      [provider('deepseek'), provider('openai')],
    );
    expect(index.fallbacks('deepseek:chat')).toContain('openai:mini');
  });

  // docs/04: zincirin son durağı varsayılan sağlayıcının modelidir.
  it('varsayılan sağlayıcının modelini son durak olarak ekler', () => {
    const index = buildRoutingIndex(
      [role('worker', 'deepseek:chat')],
      [provider('deepseek'), provider('openai', { isDefault: true, models: ['gpt-5-mini'] })],
    );
    expect(index.fallbacks('deepseek:chat').at(-1)).toBe('openai:gpt-5-mini');
  });

  it('modelin kendisi kendi yedeği olamaz', () => {
    const index = buildRoutingIndex(
      [role('worker', 'openai:gpt-5-mini', ['openai:gpt-5-mini'])],
      [provider('openai', { isDefault: true, models: ['gpt-5-mini'] })],
    );
    expect(index.fallbacks('openai:gpt-5-mini')).toEqual([]);
  });

  // Pasif sağlayıcıya düşmek sessiz bir hataya koşmaktır.
  it('pasif sağlayıcıya ait yedeği zincirden çıkarır', () => {
    const index = buildRoutingIndex(
      [role('worker', 'deepseek:chat', ['kapali:model'])],
      [provider('deepseek'), provider('kapali', { enabled: false })],
    );
    expect(index.fallbacks('deepseek:chat')).not.toContain('kapali:model');
  });

  it('kayıtlı olmayan sağlayıcıya ait yedeği zincirden çıkarır', () => {
    const index = buildRoutingIndex(
      [role('worker', 'deepseek:chat', ['hayalet:model'])],
      [provider('deepseek')],
    );
    expect(index.fallbacks('deepseek:chat')).toEqual([]);
  });

  it('aynı modele eşlenen iki rolün yedeklerini birleştirir ve tekrarı eler', () => {
    const index = buildRoutingIndex(
      [
        role('worker', 'deepseek:chat', ['openai:mini']),
        role('verifier', 'deepseek:chat', ['openai:mini', 'anthropic:sonnet']),
      ],
      [provider('deepseek'), provider('openai', { models: ['mini'] }), provider('anthropic', { models: ['sonnet'] })],
    );
    const chain = index.fallbacks('deepseek:chat');
    expect(chain).toEqual(['openai:mini', 'anthropic:sonnet']);
  });

  it('bilinmeyen model için boş zincir döner', () => {
    const index = buildRoutingIndex([], [provider('deepseek')]);
    expect(index.fallbacks('yok:model')).toEqual([]);
  });

  it('varsayılan sağlayıcı modelsizse son durak eklemez', () => {
    const index = buildRoutingIndex(
      [role('worker', 'deepseek:chat')],
      [provider('deepseek'), provider('bos', { isDefault: true, models: [] })],
    );
    expect(index.fallbacks('deepseek:chat')).toEqual([]);
  });

  it('biçimsiz model referansını yok sayar', () => {
    const index = buildRoutingIndex(
      [role('worker', 'bicimsiz', ['openai:mini'])],
      [provider('openai', { models: ['mini'] })],
    );
    expect(index.modelForRole('worker')).toBeUndefined();
  });
});
