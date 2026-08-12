import { expect, it } from 'vitest';
import { mapError } from './errors.js';
import { ProviderError } from '../types.js';

it('HTTP durumlarını hata türlerine eşler', () => {
  expect(mapError({ status: 401, message: 'unauthorized' }, 'openai').kind).toBe('auth');
  expect(mapError({ status: 429, message: 'slow down' }, 'openai').kind).toBe('rate_limited');
  expect(mapError({ status: 503, message: 'oops' }, 'openai').kind).toBe('server');
  expect(mapError({ status: 400, message: 'bad' }, 'openai').kind).toBe('bad_request');
  expect(mapError({ name: 'AbortError' }, 'openai').kind).toBe('timeout');
  expect(mapError(new Error('socket hang up'), 'openai').kind).toBe('connection');
});

it('retryable ayrımı doğrudur ve ProviderError aynen geçer', () => {
  expect(mapError({ status: 500 }, 'x').retryable).toBe(true);
  expect(mapError({ status: 401 }, 'x').retryable).toBe(false);
  expect(mapError({ status: 400 }, 'x').retryable).toBe(false);
  const orig = new ProviderError('zaten eşlenmiş', 'timeout');
  expect(mapError(orig, 'x')).toBe(orig);
});
