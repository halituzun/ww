import { describe, expect, it, vi } from 'vitest';
import { notifyUnexpectedError } from './unexpected-error-observer.js';

const context = {
  effectType: 'provider_completion_v1',
  stableEffectId: 'provider-invocation:abc:0',
  state: 'uncertain' as const,
};

describe('notifyUnexpectedError', () => {
  it('ham hatayı gözlemciye iletir', () => {
    const observer = vi.fn();
    const raw = new TypeError('provider adaptörü bozuk');
    notifyUnexpectedError(observer, raw, context);

    expect(observer).toHaveBeenCalledWith(raw, context);
  });

  it('gözlemci yoksa sessizce geçer', () => {
    expect(() => notifyUnexpectedError(undefined, new Error('x'), context)).not.toThrow();
  });

  // Teşhis kanalı, asıl hata yolunu kırmamalı.
  it('gözlemcinin kendi hatasını yutar', () => {
    expect(() => notifyUnexpectedError(
      () => { throw new Error('gözlemci patladı'); },
      new Error('x'),
      context,
    )).not.toThrow();
  });

  it('bağlamı olduğu gibi geçirir', () => {
    const observer = vi.fn();
    notifyUnexpectedError(observer, 'düz metin', context);
    expect(observer.mock.calls[0]![1]).toEqual(context);
  });
});
