/**
 * Geç bağlanan port.
 *
 * Sıra sorunu: `schedulerOperations` ve `toolFactory` composition'a GİRDİ
 * olarak verilir, ama ihtiyaç duydukları servisler (taskTransitionService,
 * assignmentService, toolExecutor) composition'ın İÇİNDE kurulur. Kapanışlar
 * ancak orkestrasyon sırasında çağrıldığı için geç bağlama doğru çözümdür.
 *
 * `undefined as never` yer tutucusu yerine bunu kullanmak şart: bağlanmamış
 * bir port sessizce `undefined` çökmesi verirse, hata gerçek sebebinden
 * (kablolama unutulmuş) çok uzakta görünür.
 */
export interface LateBoundPort<T extends object> {
  proxy: T;
  bind(implementation: T): void;
  isBound(): boolean;
}

export function createLateBoundPort<T extends object>(name: string): LateBoundPort<T> {
  let implementation: T | undefined;

  const proxy = new Proxy({} as T, {
    get(_target, property) {
      if (implementation === undefined) {
        // Erişim anında değil, ÇAĞRI anında hata ver: bazı kütüphaneler
        // özellik varlığını yoklar ve erken hata kabloyu kırar.
        return (...args: unknown[]) => {
          void args;
          throw new Error(`${name} henüz bağlanmadı — composition kurulduktan sonra bind() çağrılmalı`);
        };
      }
      const value = Reflect.get(implementation as object, property) as unknown;
      // Sınıf metotlarının `this` bağlamı korunmalı.
      return typeof value === 'function' ? value.bind(implementation) : value;
    },
  });

  return {
    proxy,
    bind(next: T): void {
      if (implementation !== undefined) {
        throw new Error(`${name} zaten bağlı — ikinci bağlama hangi uygulamanın canlı olduğunu belirsizleştirir`);
      }
      implementation = next;
    },
    isBound: () => implementation !== undefined,
  };
}
