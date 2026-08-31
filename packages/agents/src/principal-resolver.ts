import { timingSafeEqual } from 'node:crypto';
import {
  AuthenticatedPrincipalSnapshotV1Schema,
  EntityIdSchema,
  SYSTEM_SENTINEL,
  USER_SENTINEL,
  type AuthenticatedPrincipalV1,
  type AuthenticatedPrincipalSnapshotV1,
  type EntityId,
} from '@ww/shared';
import { getLatestAgent, type ClickHouseClient } from '@ww/db';
import { CommunicationError } from './errors.js';
import {
  type AgentCapabilityBinding,
  type PrincipalAuthentication,
} from './ports.js';

export interface PrincipalResolverOptions {
  readonly localSessionToken: string;
  readonly agentCapabilities?: ReadonlyMap<string, AgentCapabilityBinding>;
  readonly internalServiceTokens?: ReadonlyMap<string, string>;
}

function nonemptySecret(value: string, context: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CommunicationError('INVALID_AUTHENTICATION', `${context} bos olamaz`);
  }
  return value;
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function parseAuthentication(value: PrincipalAuthentication): PrincipalAuthentication {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CommunicationError('INVALID_AUTHENTICATION', 'principal authentication nesne olmalidir');
  }
  const record = value as unknown as Record<string, unknown>;
  if (
    Reflect.ownKeys(record).length !== 3 ||
    typeof record['type'] !== 'string' ||
    typeof record['credential'] !== 'string' ||
    typeof record['issuedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(record['issuedAt'])) ||
    !['local_user', 'agent_capability', 'internal_service'].includes(record['type'])
  ) {
    throw new CommunicationError(
      'INVALID_AUTHENTICATION',
      'principal authentication type, opaque credential ve trusted issuedAt tasimalidir',
    );
  }
  return Object.freeze({
    type: record['type'] as PrincipalAuthentication['type'],
    credential: nonemptySecret(record['credential'], 'credential'),
    issuedAt: new Date(Date.parse(record['issuedAt'])).toISOString(),
  }) as PrincipalAuthentication;
}

export class PrincipalResolver {
  readonly #ch: ClickHouseClient;
  readonly #localSessionToken: string;
  readonly #agentCapabilities: ReadonlyMap<string, AgentCapabilityBinding>;
  readonly #internalServiceTokens: ReadonlyMap<string, string>;

  constructor(ch: ClickHouseClient, options: PrincipalResolverOptions) {
    this.#ch = ch;
    this.#localSessionToken = nonemptySecret(options.localSessionToken, 'localSessionToken');
    this.#agentCapabilities = options.agentCapabilities ?? new Map();
    this.#internalServiceTokens = options.internalServiceTokens ?? new Map();
  }

  async resolve(
    authentication: PrincipalAuthentication,
    projectIdValue: string,
  ): Promise<AuthenticatedPrincipalV1> {
    const auth = parseAuthentication(authentication);
    const projectId = EntityIdSchema.parse(projectIdValue);
    const authenticatedAt = auth.issuedAt;

    if (auth.type === 'local_user') {
      if (!secureEqual(auth.credential, this.#localSessionToken)) {
        throw new CommunicationError('INVALID_AUTHENTICATION', 'yerel kullanici oturumu gecersiz');
      }
      return Object.freeze({
        principalType: 'user',
        principalId: USER_SENTINEL,
        authenticatedAt,
      });
    }

    if (auth.type === 'internal_service') {
      const serviceName = this.#internalServiceTokens.get(auth.credential);
      if (serviceName === undefined || serviceName.trim().length === 0) {
        throw new CommunicationError('INVALID_AUTHENTICATION', 'internal service token gecersiz');
      }
      return Object.freeze({
        principalType: 'system',
        principalId: SYSTEM_SENTINEL,
        serviceName,
        authenticatedAt,
      });
    }

    const binding = this.#agentCapabilities.get(auth.credential);
    if (binding === undefined) {
      throw new CommunicationError('INVALID_AUTHENTICATION', 'agent capability gecersiz');
    }
    const bindingProject = EntityIdSchema.parse(binding.projectId);
    const agentId: EntityId = EntityIdSchema.parse(binding.agentId);
    if (bindingProject !== projectId) {
      throw new CommunicationError('INVALID_AUTHENTICATION', 'agent capability proje ile eslesmiyor');
    }
    const agent = await getLatestAgent(this.#ch, projectId, agentId);
    if (agent === null) {
      throw new CommunicationError('PRINCIPAL_NOT_FOUND', 'capability agent kaydi bulunamadi');
    }
    if (agent.status === 'stopped') {
      throw new CommunicationError('PRINCIPAL_STOPPED', 'stopped agent mesaj gonderemez');
    }
    const agentVersion = Number(agent.version);
    if (!Number.isSafeInteger(agentVersion) || agentVersion < 0) {
      throw new CommunicationError('INVALID_AUTHENTICATION', 'agent surumu runtime araliginda degil');
    }
    return Object.freeze({
      principalType: 'agent',
      principalId: agent.agent_id,
      role: agent.role,
      agentVersion,
      authenticatedAt,
    });
  }

  assertMatchesSealed(
    authentication: PrincipalAuthentication,
    projectIdValue: string,
    snapshotValue: AuthenticatedPrincipalSnapshotV1,
  ): void {
    const auth = parseAuthentication(authentication);
    const projectId = EntityIdSchema.parse(projectIdValue);
    const snapshot = AuthenticatedPrincipalSnapshotV1Schema.parse(snapshotValue);
    if (auth.issuedAt !== snapshot.authenticatedAt) {
      throw new CommunicationError(
        'INVALID_AUTHENTICATION',
        'authentication evidence sealed principal zamaniyla eslesmiyor',
      );
    }
    if (auth.type === 'local_user') {
      if (
        snapshot.principalType !== 'user' ||
        !secureEqual(auth.credential, this.#localSessionToken)
      ) {
        throw new CommunicationError('INVALID_AUTHENTICATION', 'sealed user evidence eslesmiyor');
      }
      return;
    }
    if (auth.type === 'internal_service') {
      const serviceName = this.#internalServiceTokens.get(auth.credential);
      if (
        snapshot.principalType !== 'system' ||
        serviceName === undefined ||
        serviceName !== snapshot.serviceName
      ) {
        throw new CommunicationError('INVALID_AUTHENTICATION', 'sealed system evidence eslesmiyor');
      }
      return;
    }
    const binding = this.#agentCapabilities.get(auth.credential);
    if (
      snapshot.principalType !== 'agent' ||
      binding === undefined ||
      EntityIdSchema.parse(binding.projectId) !== projectId ||
      EntityIdSchema.parse(binding.agentId) !== snapshot.principalId
    ) {
      throw new CommunicationError('INVALID_AUTHENTICATION', 'sealed agent evidence eslesmiyor');
    }
  }
}
