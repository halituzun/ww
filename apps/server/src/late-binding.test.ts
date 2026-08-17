import { describe, expect, it, vi } from 'vitest';
import { createLateBoundPort } from './late-binding.js';

describe('createLateBoundPort', () => {
  // Composition'ın kendi servisleri (taskTransitionService, assignmentService,
  // toolExecutor) ancak composition KURULDUKTAN sonra var olur; ama
  // schedulerOperations composition'a GİRDİ olarak verilir. Geç bağlama bu
  // sırayı çözer — ama bağlanmadan çağrı sessiz undefined çökmesi olmamalı.
  it('bağlanmadan çağrılırsa hangi parçanın eksik olduğunu söyler', () => {
    const port = createLateBoundPort<{ apply: () => string }>('taskTransitionService');
    expect(() => port.proxy.apply()).toThrow(/taskTransitionService/);
    expect(() => port.proxy.apply()).toThrow(/bağlanmad/i);
  });

  it('bağlandıktan sonra gerçek uygulamaya yönlendirir', () => {
    const port = createLateBoundPort<{ apply: () => string }>('x');
    port.bind({ apply: () => 'gerçek' });
    expect(port.proxy.apply()).toBe('gerçek');
  });

  it('asenkron metotları da yönlendirir', async () => {
    const port = createLateBoundPort<{ run: () => Promise<number> }>('x');
    port.bind({ run: async () => 42 });
    await expect(port.proxy.run()).resolves.toBe(42);
  });

  it('this bağlamını korur (sınıf metotları çalışmalı)', () => {
    class Service { value = 7; read(): number { return this.value; } }
    const port = createLateBoundPort<Service>('x');
    port.bind(new Service());
    expect(port.proxy.read()).toBe(7);
  });

  // İkinci kez bağlamak, hangi uygulamanın canlı olduğunu belirsizleştirir.
  it('iki kez bağlamayı reddeder', () => {
    const port = createLateBoundPort<{ a: () => void }>('x');
    port.bind({ a: () => undefined });
    expect(() => port.bind({ a: () => undefined })).toThrow(/zaten bağlı/i);
  });

  it('bağlı olup olmadığını bildirir', () => {
    const port = createLateBoundPort<{ a: () => void }>('x');
    expect(port.isBound()).toBe(false);
    port.bind({ a: vi.fn() });
    expect(port.isBound()).toBe(true);
  });
});
