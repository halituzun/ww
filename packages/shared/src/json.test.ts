import { describe, expect, it } from 'vitest';
import {
  JsonValueSchema,
  canonicalJsonV1,
  canonicalSha256V1,
} from './json.js';

describe('strict JSON and canonical hashing', () => {
  it('valid JSON girdisini caller-owned değerden ayırıp deep-freeze eder', () => {
    const callerOwned = { nested: [{ value: 1 }], enabled: true };
    const parsed = JsonValueSchema.parse(callerOwned);
    expect(parsed).not.toBe(callerOwned);
    expect(Object.isFrozen(parsed)).toBe(true);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('JSON object bekleniyordu');
    }
    const nested = parsed['nested'];
    expect(Array.isArray(nested)).toBe(true);
    expect(Object.isFrozen(nested)).toBe(true);
    callerOwned.nested[0]!.value = 2;
    expect(nested?.[0]).toEqual({ value: 1 });
  });

  it('canonical JSON anahtar sırasını sabitler ve bilinen SHA-256 vektörünü üretir', () => {
    expect(canonicalJsonV1({ b: 2, a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"b":2}',
    );
    expect(canonicalSha256V1({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalSha256V1({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(canonicalSha256V1({})).toBe(
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
  });

  it('global structuredClone bulunmadan valid JSON ve canonical hash üretir', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone');
    Object.defineProperty(globalThis, 'structuredClone', {
      configurable: true,
      value: undefined,
      writable: true,
    });
    try {
      expect(JsonValueSchema.parse({ ok: [1, true] })).toEqual({ ok: [1, true] });
      expect(canonicalJsonV1({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
      expect(canonicalSha256V1({})).toBe(
        '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      );
    } finally {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, 'structuredClone');
      } else {
        Object.defineProperty(globalThis, 'structuredClone', descriptor);
      }
    }
  });

  it('non-JSON ve canonical-collision girdilerini fail-closed reddeder', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const hidden = Object.defineProperty({}, 'hidden', { enumerable: false, value: 1 });
    const invalidInputs: unknown[] = [
      undefined,
      () => 'nope',
      Symbol('nope'),
      Number.POSITIVE_INFINITY,
      new Date('2026-08-14T08:00:00.000Z'),
      cyclic,
      Array(1),
      { bad: undefined },
      { bad: Symbol('nope') },
      { [Symbol('nope')]: true },
      hidden,
      JSON.parse('{"__proto__":{"polluted":true}}'),
      { constructor: { prototype: { polluted: true } } },
      { prototype: { polluted: true } },
    ];

    for (const input of invalidInputs) {
      expect(() => JsonValueSchema.safeParse(input)).not.toThrow();
      expect(JsonValueSchema.safeParse(input).success).toBe(false);
      expect(() => canonicalJsonV1(input)).toThrow();
      expect(() => canonicalSha256V1(input)).toThrow();
    }
  });

  it('descriptor-okumalı proxy get traplerini çağırmadan clone eder', () => {
    let proxyGetCalls = 0;
    const objectProxy = new Proxy({ ok: 1 }, {
      get() {
        proxyGetCalls += 1;
        throw new Error('get trap');
      },
    });
    const arrayProxy = new Proxy([1], {
      get() {
        proxyGetCalls += 1;
        throw new Error('array get trap');
      },
    });

    expect(JsonValueSchema.parse(objectProxy)).toEqual({ ok: 1 });
    expect(JsonValueSchema.parse(arrayProxy)).toEqual([1]);
    expect(canonicalJsonV1(objectProxy)).toBe('{"ok":1}');
    expect(proxyGetCalls).toBe(0);
  });

  it('accessor ve hostile descriptor traplerini çağırmadan veya sızdırmadan reddeder', () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'bad', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('getter invoked');
      },
    });
    const inputs: unknown[] = [
      accessor,
      new Proxy({ ok: 1 }, { ownKeys() { throw new Error('ownKeys trap'); } }),
      new Proxy({ ok: 1 }, {
        getOwnPropertyDescriptor() { throw new Error('descriptor trap'); },
      }),
      new Proxy({ ok: 1 }, { getPrototypeOf() { throw new Error('prototype trap'); } }),
      new Proxy([1], { ownKeys() { throw new Error('array ownKeys trap'); } }),
      new Proxy([1], {
        getOwnPropertyDescriptor() { throw new Error('array descriptor trap'); },
      }),
      new Proxy([1], { getPrototypeOf() { throw new Error('array prototype trap'); } }),
    ];

    for (const input of inputs) {
      expect(() => JsonValueSchema.safeParse(input)).not.toThrow();
      expect(JsonValueSchema.safeParse(input).success).toBe(false);
      expect(() => canonicalJsonV1(input)).toThrow();
      expect(() => canonicalSha256V1(input)).toThrow();
    }
    expect(getterCalls).toBe(0);
  });
});
