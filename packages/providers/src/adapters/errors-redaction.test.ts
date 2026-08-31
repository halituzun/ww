// Sağlayıcı hata mesajlarında ANAHTAR SIZINTISI.
//
// NEDEN VAR: bu mesaj `api_usage`'a, `events`'e (yığın izi dahil) ve sunucu
// loglarına KALICI olarak yazılır. Sağlayıcılar kimlik hatalarında anahtarı
// mesaja koyabilir; `redactKeys` tam bunun için yazılmıştı ama hiçbir yerden
// çağrılmıyordu — yani sızıntıyı önleyen kod vardı ve kapalıydı.
import { describe, expect, it } from 'vitest';
import { mapError } from './errors.js';

const asError = (message: string, status?: number): unknown =>
  Object.assign(new Error(message), status === undefined ? {} : { status });

describe('mapError — anahtar redaksiyonu', () => {
  it('openai bicimli anahtari maskeler', () => {
    const error = mapError(asError('Invalid API key: sk-abcdefgh12345678', 401), 'openai');
    expect(error.message).not.toContain('abcdefgh12345678');
    expect(error.message).toContain('REDACTED');
  });

  it('anthropic bicimli anahtari maskeler', () => {
    const error = mapError(asError('bad key sk-ant-0123456789abcdef', 401), 'anthropic');
    expect(error.message).not.toContain('0123456789abcdef');
  });

  it('deepseek bicimli anahtari maskeler', () => {
    const error = mapError(asError('auth failed for ds-9876543210abcdef', 401), 'deepseek');
    expect(error.message).not.toContain('9876543210abcdef');
  });

  // Redaksiyon TANIYI bozmamalı: sağlayıcı adı ve hata sınıfı korunur.
  it('taniyi bozmaz', () => {
    const error = mapError(asError('402 Insufficient Balance', 402), 'deepseek');
    expect(error.message).toContain('deepseek');
    expect(error.message).toContain('Insufficient Balance');
  });

  it('anahtar icermeyen mesaji degistirmez', () => {
    expect(mapError(asError('connection reset'), 'mock').message)
      .toBe('mock: connection reset');
  });
});
