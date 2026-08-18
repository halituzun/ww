import { ProviderError, type ProviderErrorKind } from '../types.js';
import { redactKeys } from '../keystore.js';

interface HttpLikeError {
  status?: number;
  name?: string;
  message?: string;
  code?: string;
}

// SDK hatalarını tek hata modeline indirger (docs/05-executor.md → hata politikaları).
export function mapError(e: unknown, providerId: string): ProviderError {
  if (e instanceof ProviderError) return e;

  const err = (e ?? {}) as HttpLikeError;
  const status = err.status;
  const kind: ProviderErrorKind =
    status === 401 || status === 403
      ? 'auth'
      : status === 429
        ? 'rate_limited'
        : status !== undefined && status >= 500
          ? 'server'
          : status !== undefined && status >= 400
            ? 'bad_request'
            : err.name === 'AbortError' || err.code === 'ETIMEDOUT'
              ? 'timeout'
              : 'connection';

  // ANAHTAR SIZINTISI: bu mesaj api_usage'a, events'e (yığın izi dahil) ve
  // sunucu loglarına KALICI olarak yazılır. Sağlayıcılar kimlik hatalarında
  // anahtarı mesaja koyabilir; `redactKeys` tam bunun için yazılmıştı ama
  // hiçbir yerden çağrılmıyordu.
  return new ProviderError(redactKeys(`${providerId}: ${err.message ?? String(e)}`), kind);
}
