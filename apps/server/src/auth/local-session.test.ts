import { describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { parseLocalSession } from './local-session.js';

describe('local session', () => {
  it('bearer token üzerinden yalnız kullanıcı principal üretir', () => {
    const principal = parseLocalSession({ headers: { authorization: 'Bearer fixture' } }, 'fixture');
    expect(principal.principalType).toBe('user');
    expect(principal.principalId).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('eksik veya yanlış token için kalıcı servise ulaşmadan reddeder', () => {
    expect(() => parseLocalSession({ headers: {} }, 'fixture')).toThrow(UnauthorizedException);
    expect(() => parseLocalSession({ headers: { authorization: 'Bearer wrong' } }, 'fixture')).toThrow(UnauthorizedException);
  });
});
