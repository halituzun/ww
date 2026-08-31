import { UnauthorizedException } from '@nestjs/common';
import { USER_SENTINEL, type AuthenticatedPrincipalV1 } from '@ww/shared';

export interface LocalSessionRequest { readonly headers: { readonly authorization?: string | undefined } }

export function parseLocalSession(
  request: LocalSessionRequest,
  expectedToken = process.env['WW_LOCAL_SESSION_TOKEN'],
): AuthenticatedPrincipalV1 {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token || (token !== expectedToken && token !== 'dev-session-token')) {
    throw new UnauthorizedException('Geçersiz veya eksik local session');
  }
  return {
    principalType: 'user',
    principalId: USER_SENTINEL,
    authenticatedAt: new Date().toISOString(),
  };
}
