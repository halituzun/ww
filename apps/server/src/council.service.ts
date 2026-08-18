// Konseyin ÜRETİM yolu (docs/03 → Konsey, docs/11 → Faz 4).
//
// NEDEN VAR: `CouncilService` protokolü packages/agents içinde yazılmış ve
// testliydi ama `apps/` içinde tek bir referansı yoktu — yani Faz 4'ün kalbi
// hiçbir yerden çağrılamıyordu. Bu modül onu gerçek modellere, gerçek mesaj
// kanalına ve gerçek plan kaydına bağlar.
//
// Konsey turları `purpose: 'council'` ile çağrılır: gerçek ve paralı çağrılardır,
// `api_usage`'a yazılırlar, ama göreve bağlı olmadıkları için 'completion'ın
// brief/attempt provenance'ını taşımazlar.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  createPlan,
  getLatestProject,
  listLatestAgents,
  listLatestApiProviders,
  listLatestPlansByStatus,
} from '@ww/db';
import {
  CommunicationService,
  CouncilService as CouncilProtocol,
  PrincipalResolver,
} from '@ww/agents';
import { CommunicationWakeupPublisher, createRedis } from '@ww/db';
import { buildAgentCapabilities } from './agent-capabilities.js';
import { Keystore, ModelRouter, buildProviderRegistry, chUsageSink } from '@ww/providers';
import type { EntityId } from '@ww/shared';
import { composeCouncil } from './council-members.js';
import { buildCouncilPlan } from './council-plan.js';
import { loadRoutingIndex } from './routing.loader.js';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';

export class CouncilRunError extends Error {}

/** Konsey turunu kalıcı yazan taşıma; testte sahte, üretimde mesaj kanalı. */
export type CouncilTransportSend = (turn: Readonly<{
  sessionId: EntityId;
  speakerId: EntityId;
  recipientId: EntityId;
  kind: string;
  text: string;
}>) => Promise<{ messageId: string }>;

export interface CouncilRunResult {
  readonly planId: EntityId;
  readonly sessionId: EntityId;
  readonly memberModelRefs: readonly string[];
  readonly distinctProviders: number;
  readonly diversityWarning: string;
  readonly turns: number;
}

/** Konsey turunun modele gönderilen istemi; her tur öncekileri görür. */
function turnPrompt(
  kind: string,
  goal: string,
  prior: readonly { readonly kind: string; readonly text: string }[],
): string {
  const history = prior.length === 0
    ? '(henüz tur yok)'
    : prior.map((turn) => `[${turn.kind}] ${turn.text}`).join('\n\n');
  const instruction = kind === 'proposal'
    ? 'Hedef için somut bir plan öner. Kısa ve uygulanabilir yaz.'
    : kind === 'objection'
      ? 'Önceki önerilerin EN ZAYIF noktasını göster. Katılıyorsan bile bir risk yaz.'
      : 'Tüm turları tek bir karara sentezle. Kararı ve gerekçesini yaz.';
  return [`Hedef: ${goal}`, '', 'Önceki turlar:', history, '', instruction].join('\n');
}

@Injectable()
export class CouncilApplicationService {
  readonly #logger = new Logger(CouncilApplicationService.name);
  readonly #database: ServerDatabase;

  readonly #transport: CouncilTransportSend | undefined;

  constructor(
    @Inject(SERVER_DATABASE) database: ServerDatabase,
    // Testler gerçek modele gitmeden taşımayı doğrulayabilsin diye enjekte
    // edilebilir; üretimde varsayılan mesaj kanalı kurulur. @Optional()
    // olmadan Nest bu parametreyi çözmeye çalışıp tüm modülü düşürüyordu.
    @Optional() transport?: CouncilTransportSend,
  ) {
    this.#database = database;
    this.#transport = transport;
  }

  /** Konsey turlarını gerçek mesaj kanalına yazan varsayılan taşıma. */
  async #defaultTransport(
    projectId: EntityId,
    agents: readonly { readonly agent_id: string; readonly role: string; readonly status: string }[],
  ): Promise<CouncilTransportSend> {
    const token = process.env['WW_LOCAL_SESSION_TOKEN'];
    if (token === undefined || token.trim() === '') {
      throw new CouncilRunError('WW_LOCAL_SESSION_TOKEN ayarli degil: konsey turlari yazilamaz');
    }
    const redis = this.#database.redis ?? await createRedis();
    const built = buildAgentCapabilities(projectId, agents as never);
    const resolver = new PrincipalResolver(this.#database.ch, {
      localSessionToken: token,
      agentCapabilities: built.capabilities as never,
    });
    const communication = new CommunicationService(
      this.#database.ch, redis, resolver, new CommunicationWakeupPublisher(redis),
    );
    return async (turn) => {
      const credential = built.credentialFor(turn.speakerId);
      if (credential === undefined) {
        throw new CouncilRunError(`konsey uyesi kimlik bilgisi yok: ${turn.speakerId}`);
      }
      const envelope = await communication.send(
        { type: 'agent', credential, issuedAt: new Date().toISOString() } as never,
        {
          projectId,
          sessionId: turn.sessionId,
          recipient: { type: 'agent', id: turn.recipientId },
          kind: turn.kind,
          payload: { type: turn.kind, text: turn.text },
          idempotencyKey: `council:${turn.sessionId}:${turn.speakerId}:${turn.kind}:${turn.text.length}`,
        } as never,
      );
      return { messageId: String((envelope as { messageId: string }).messageId) };
    };
  }

  async run(projectId: string, goal: string): Promise<CouncilRunResult> {
    const trimmedGoal = goal.trim();
    if (trimmedGoal === '') throw new CouncilRunError('konsey hedefi bos olamaz');

    const project = await getLatestProject(this.#database.ch, projectId);
    if (project === null) throw new CouncilRunError('proje bulunamadi');

    const routing = await loadRoutingIndex(this.#database.ch);
    const providerRows = await listLatestApiProviders(this.#database.ch);
    // base_url'ü boş sağlayıcı ağ çağrısı yapmaz: taklittir ve konsey üyesi
    // olamaz (bkz. council-members.ts).
    const stubProviders = providerRows
      .filter((row) => row.base_url.trim() === '')
      .map((row) => row.provider_id);
    const agents = await listLatestAgents(this.#database.ch, project.project_id as EntityId);
    const active = agents.filter((agent) => agent.status !== 'stopped');
    const composition = composeCouncil(active.map((agent) => ({
      agentId: agent.agent_id as EntityId,
      // Rol eşlemesi yoksa agent'ın kendi modeli kullanılır; ikisi de yoksa
      // composeCouncil onu saymaz ve eksiklik açık hata olur.
      modelRef: routing.modelForRole(agent.role) ?? agent.model_ref,
    })), { stubProviders });
    if (composition.diversityWarning !== '') {
      this.#logger.warn(composition.diversityWarning);
    }

    const store = await Keystore.open(
      process.env['WW_KEYSTORE_FILE'] ?? `${process.cwd()}/.ww/keys.json`,
    );
    const registry = await buildProviderRegistry(providerRows.map((row) => ({
      provider_id: row.provider_id, base_url: row.base_url,
      enabled: row.enabled, models: row.models, key_ref: row.key_ref,
    })), store);
    const router = new ModelRouter(registry.providers, {
      fallbacks: (modelRef) => routing.fallbacks(modelRef),
      // Konsey turları da paralıdır: kontör panosunda görünmeleri gerekir.
      usageSink: chUsageSink(this.#database.ch),
    });

    const sessionId = randomUUID() as EntityId;
    // TURLAR KALICI YAZILIR. Önceki hâli yalnızca bellekte bir diziye
    // topluyordu: plan `council_session_id` ile oturuma bağlanıyor ama o
    // oturumun HİÇBİR mesajı yoktu, yani "bu karar nasıl alındı" zinciri
    // (plan → oturum → mesajlar) boşa çıkıyordu.
    //
    // Mesaj yazımı düşerse konsey DURUR: yarısı kayıtlı bir tartışma,
    // kaydı hiç olmayandan daha yanıltıcıdır.
    const transcript: { kind: string; text: string; memberId: string }[] = [];
    const chair = composition.members[0]!;
    const send = this.#transport ?? await this.#defaultTransport(
      project.project_id as EntityId, active,
    );
    const protocol = new CouncilProtocol({
      send: async (input) => {
        transcript.push({
          kind: input.kind, text: input.text, memberId: String(input.recipient),
        });
        // Konuşan üye kendi adına yazar; alıcı başkandır (sentezi o üretir).
        return send({
          sessionId: input.sessionId,
          speakerId: input.recipient as EntityId,
          recipientId: chair.agentId,
          kind: input.kind,
          text: input.text,
        });
      },
    });

    const result = await protocol.run(
      { sessionId, members: composition.members, prompt: trimmedGoal, maxCycles: 1 },
      async ({ kind, member, prior }) => {
        const routed = await router.complete(member.modelRef, {
          messages: [{ role: 'user', content: turnPrompt(kind, trimmedGoal, prior) }],
          meta: {
            purpose: 'council',
            projectId: project.project_id,
            agentId: member.agentId,
          },
        });
        // Boş içerik konseyi sessizce bozar: protokol boş turu reddeder ama
        // sebebi görünmez olur. Burada AÇIKÇA söylenir.
        const text = routed.result.content;
        if (text === null || text.trim() === '') {
          throw new CouncilRunError(`konsey turu bos dondu: ${member.modelRef} (${kind})`);
        }
        return { text };
      },
    );

    const existing = [
      ...await listLatestPlansByStatus(this.#database.ch, project.project_id, 'approved'),
      ...await listLatestPlansByStatus(this.#database.ch, project.project_id, 'proposed'),
    ];
    const planVersion = existing.reduce((max, plan) => Math.max(max, plan.plan_version), 0) + 1;
    const planId = randomUUID() as EntityId;
    await createPlan(this.#database.ch, buildCouncilPlan({
      projectId: project.project_id as EntityId,
      projectName: project.name,
      planId,
      planVersion,
      sessionId,
      chairAgentId: composition.members[0]!.agentId,
      goal: trimmedGoal,
      proposals: result.proposals,
      objections: result.objections,
      synthesis: result.synthesis,
      memberModelRefs: composition.members.map((member) => member.modelRef),
      diversityWarning: composition.diversityWarning,
      createdAt: new Date().toISOString(),
    }) as never);

    return Object.freeze({
      planId,
      sessionId,
      memberModelRefs: composition.members.map((member) => member.modelRef),
      distinctProviders: composition.distinctProviders,
      diversityWarning: composition.diversityWarning,
      turns: transcript.length,
    });
  }
}
