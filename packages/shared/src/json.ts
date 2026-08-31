import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

type JsonCloneResult =
  | { readonly success: true; readonly value: JsonValue }
  | { readonly success: false };

const JSON_CLONE_FAILURE = { success: false } as const;
const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function cloneStrictJsonValue(value: unknown, ancestors: Set<object>): JsonCloneResult {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return { success: true, value };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { success: true, value } : JSON_CLONE_FAILURE;
  }
  if (typeof value !== 'object' || ancestors.has(value)) return JSON_CLONE_FAILURE;

  ancestors.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return JSON_CLONE_FAILURE;

      const ownKeys = Reflect.ownKeys(value);
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (
        lengthDescriptor === undefined ||
        lengthDescriptor.enumerable ||
        !('value' in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        ownKeys.length !== lengthDescriptor.value + 1
      ) return JSON_CLONE_FAILURE;

      const clone: JsonValue[] = new Array<JsonValue>(lengthDescriptor.value);
      for (const key of ownKeys) {
        if (key === 'length') continue;
        if (typeof key !== 'string') return JSON_CLONE_FAILURE;
        const index = Number(key);
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= lengthDescriptor.value ||
          String(index) !== key
        ) return JSON_CLONE_FAILURE;

        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !('value' in descriptor)
        ) return JSON_CLONE_FAILURE;
        const item = cloneStrictJsonValue(descriptor.value, ancestors);
        if (!item.success) return JSON_CLONE_FAILURE;
        clone[index] = item.value;
      }
      return { success: true, value: clone };
    }

    if (prototype !== Object.prototype && prototype !== null) return JSON_CLONE_FAILURE;
    const clone: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || PROTOTYPE_POLLUTION_KEYS.has(key)) {
        return JSON_CLONE_FAILURE;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !('value' in descriptor)
      ) return JSON_CLONE_FAILURE;
      const item = cloneStrictJsonValue(descriptor.value, ancestors);
      if (!item.success) return JSON_CLONE_FAILURE;
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: item.value,
        writable: true,
      });
    }
    return { success: true, value: clone };
  } finally {
    ancestors.delete(value);
  }
}

function cloneStrictJsonValueSafe(value: unknown): JsonCloneResult {
  try {
    // Own-property descriptors are the authority here. This keeps the boundary
    // browser-safe, never reads through getters, and does not require
    // globalThis.structuredClone. Proxy descriptor traps are still fail-closed.
    return cloneStrictJsonValue(value, new Set());
  } catch {
    return JSON_CLONE_FAILURE;
  }
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function deepFreezeJson(value: JsonValue): JsonValue {
  if (isJsonArray(value)) {
    for (const item of value) deepFreezeJson(item);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreezeJson(item);
    return Object.freeze(value);
  }
  return value;
}

const OwnedJsonValueSchema = z.custom<JsonValue>();

export const JsonValueSchema = z.preprocess((input, ctx) => {
  const cloned = cloneStrictJsonValueSafe(input);
  if (!cloned.success) {
    ctx.addIssue({
      code: 'custom',
      message: 'değer strict JSON veri modeline uymalıdır',
    });
    return null;
  }
  return cloned.value;
}, OwnedJsonValueSchema).transform((value): JsonValue => deepFreezeJson(value));

function canonicalizeOwnedJson(value: JsonValue): JsonValue {
  if (isJsonArray(value)) return value.map(canonicalizeOwnedJson);
  if (value !== null && typeof value === 'object') {
    const canonical: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(canonical, key, {
        configurable: true,
        enumerable: true,
        value: canonicalizeOwnedJson(value[key]!),
        writable: true,
      });
    }
    return canonical;
  }
  return Object.is(value, -0) ? 0 : value;
}

export function canonicalJsonV1(value: unknown): string {
  return JSON.stringify(canonicalizeOwnedJson(JsonValueSchema.parse(value)));
}

export function canonicalSha256V1(value: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJsonV1(value))));
}
