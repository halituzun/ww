import { CommunicationWakeupPublisher } from '@ww/db';
import { randomUUID } from 'node:crypto';
import { Inject, Logger, Optional } from '@nestjs/common';
import {
  CommunicationService,
  CouncilService as CouncilProtocol,
  PrincipalResolver,
  type CouncilMember,
  type CouncilTurn,
  type CouncilTurnKind,
  type ParsedDecisionItem,
  type ConvergenceCheckResult,
} from '@ww/agents';
import {
  createPlan,
  createDecision,
  getLatestProject,
  listLatestAgents,
  listLatestApiProviders,
  listLatestPlansByStatus,
} from '@ww/db';
import { buildProviderRegistry, chUsageSink, Keystore, ModelRouter, ProviderRateLimiter, resolveKeystoreFile } from '@ww/providers';
import { type EntityId, type OrgPlan } from '@ww/shared';
import { buildAgentCapabilities } from './agent-capabilities.js';
import { loadRoutingIndex } from './routing.loader.js';
import { buildCouncilPlan, deriveOrgPlan } from './council-plan.js';
import { composeCouncil } from './council-members.js';
import { providerRequestsPerMinute } from './provider-rate.js';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';
import { createRedis } from '@ww/db';
import type { MessageKind, MessagePayloadV1 } from '@ww/shared';

export class CouncilRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CouncilRunError';
  }
}

export interface CouncilTransportTurn {
  readonly sessionId: EntityId;
  readonly speakerId: EntityId;
  readonly recipientId: EntityId;
  readonly kind: CouncilTurnKind;
  readonly turnNumber: number;
  readonly turnTitle: string;
  readonly text: string;
  readonly dissenting?: boolean;
}

export type CouncilTransportSend = (turn: CouncilTransportTurn) => Promise<{ messageId: string }>;

export interface CouncilRunResult {
  readonly planId: string;
  readonly sessionId: string;
  readonly memberModelRefs: readonly string[];
  readonly distinctProviders: number;
  readonly diversityWarning: string;
  readonly turns: number;
  readonly status?: 'converged' | 'uncoordinated';
  readonly totalRounds?: number;
  readonly decisions?: readonly ParsedDecisionItem[];
  readonly convergenceLog?: readonly ConvergenceCheckResult[];
  readonly orgPlan: OrgPlan;
}

export function councilMessageForTurn(turn: Pick<CouncilTransportTurn, 'kind' | 'text'>): {
  readonly kind: MessageKind;
  readonly payload: MessagePayloadV1;
} {
  if (turn.kind === 'objection' || turn.kind === 'red_team') {
    return {
      kind: 'objection',
      payload: { type: 'objection', markdown: turn.text, evidenceRefs: [] },
    };
  }
  if (turn.kind === 'draft_synthesis' || turn.kind === 'final_synthesis') {
    return {
      kind: 'synthesis',
      payload: { type: 'synthesis', markdown: turn.text },
    };
  }
  if (turn.kind === 'research' || turn.kind === 'debate_round' || turn.kind === 'uncoordinated_report') {
    return {
      kind: 'proposal',
      payload: { type: 'proposal', markdown: turn.text },
    };
  }
  return {
    kind: 'proposal',
    payload: { type: 'proposal', markdown: turn.text },
  };
}

function cleanLlmResponse(raw: string): string {
  let text = raw.trim();
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim();
  // SADECE emoji/dingbat blokları (U+1F300–1FAFF, U+2600–27BF, U+FE0F, U+200D). Latin-1 Supplement ve Latin Extended-A asla silinmez!
  text = text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '');
  
  const lines = text.split('\n');
  const cleanedLines: string[] = [];
  let skippingEcho = true;
  for (const line of lines) {
    const withoutSpeakerEcho = line.replace(/^\s*(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{8})\s*\*{0,2}:\s*/i, '');
    const trimmed = withoutSpeakerEcho.trim();
    if (skippingEcho) {
      if (
        trimmed.startsWith('Hedef:') ||
        trimmed.startsWith('Önceki Müzakere Turları:') ||
        trimmed.startsWith('Bağlam:') ||
        trimmed.startsWith('(Henüz önceki tur yok)') ||
        trimmed.startsWith('Talimat:') ||
        trimmed.startsWith('Yönerge:') ||
        trimmed.startsWith('Rolün:') ||
        trimmed.startsWith('Görevin:') ||
        trimmed === ''
      ) {
        continue;
      }
      skippingEcho = false;
    }
    cleanedLines.push(withoutSpeakerEcho);
  }
  return cleanedLines.join('\n').trim();
}

function summarizeTurnForContext(t: CouncilTurn, maxChars: number = 300): string {
  const text = t.text.replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '...';
}

function isEnglishOrObserverText(text: string): boolean {
  const englishPatterns = /\b(based on|provided information|the team|identified|risk|mitigated|developers are required|discussing a project|in their project plan)\b/i;
  return englishPatterns.test(text);
}

export function buildCouncilTurnPrompt(
  kind: CouncilTurnKind,
  goal: string,
  prior: readonly CouncilTurn[],
  memberRole: string = 'Grup Lideri'
): string {
  let contextSection = '';
  let roleInstruction = '';

  switch (kind) {
    case 'proposal': {
      contextSection = 'Henüz önceki tur yok.';
      roleInstruction = `Sen ${memberRole} rolündesin. Hedefe ulaşmak için bağımsız plan önerini Türkçe yaz. Teknoloji seçimi, gereken departmanlar, görevler ve kabul kriterlerini belirt.
KAPSAM KURALI: SADECE verilen kullanıcı isteğindeki özellikleri planla. İstekte olmayan seslendirme, AI botu, ekstra harici servis veya uydurma özellikleri KESİNLİKLE ekleme. Gerekli gördüğün ek fikirleri plana koyma, 'Öneri/Soru' başlığı altında belirt.
Kısa, somut ve net ol (maksimum 150 kelime). Kesinlikle standart Türkçe karakterler (ç, ğ, ı, ö, ş, ü) kullan.`;
      break;
    }

    case 'research': {
      const lastPrior = prior[prior.length - 1];
      const issueText = lastPrior ? lastPrior.text : goal;
      contextSection = `Araştırılacak Teknik İhtiyaç / Belirsizlik:\n${issueText}`;
      roleInstruction = `Sen ARAŞTIRMA VE KOD İNCELEME LİDERİSİN (Researcher). Görevin projenin teknik fizibilitesini, bağımlılıklarını ve yerel kod tabanını incelemektir.
Eğer dış kaynak veya kütüphane doğrulaması internet olmadan yapılamıyorsa bunu DÜRÜSTÇE belirt ("dış kaynak doğrulanamadı, varsayım: ...").
Doğrudan şu formatta Türkçe araştırma raporu üret:
1. Teknik Bulgular ve Uyumluluk: ...
2. Yerel Kod ve Bağımlılık İncelemesi: ...
3. Konseye Öneri ve Çözüm Yolu: ...
Kesinlikle standart Türkçe karakterler (ç, ğ, ı, ö, ş, ü) kullan.`;
      break;
    }

    case 'debate_round': {
      const priorSummaries = prior.slice(-3).map((p) => `- ${p.turnTitle}: ${summarizeTurnForContext(p, 180)}`).join('\n');
      contextSection = `Açık Kalan İtirazlar ve Çelişkiler:\n${priorSummaries}`;
      roleInstruction = `Sen MÜZAKERE ELEŞTİRMENİSİN. Görevin açık kalan zıt talepleri ve çelişkileri masaya yatırıp uzlaşma için net alternatifler sunmaktır.
1. Çelişki / İtiraz Analizi: Neden uzlaşılamadı?
2. Taviz ve Çözüm Önerisi: Hangi taraf nasıl esnemeli?
3. Sentez Önerisi: ...
Kesinlikle standart Türkçe karakterler (ç, ğ, ı, ö, ş, ü) kullan.`;
      break;
    }

    case 'objection': {
      // Tur 2: Yalnızca Tur 1 tekliflerinin özetlerini al
      const propList = prior
        .filter((p) => p.kind === 'proposal')
        .map((p, i) => `Teklif ${i + 1} (Grup Lideri ${i + 1}): ${summarizeTurnForContext(p, 250)}`)
        .join('\n\n');

      contextSection = `Tur 1 Plan Önerileri:\n${propList}`;
      roleInstruction = `Sen ${memberRole} rolündesin. Görevin Tur 1'deki önerileri ELEŞTİRMEK ve somut İTİRAZLAR sunmaktır. Asla genel asistan konuşması yapma!

ÖNEMLİ: İtirazların SADECE yukarıdaki plan önerilerindeki gerçek sorunlara dayanmalıdır. Planda olmayan sorunları uydurmak yasaktır.

Doğrudan şu 3 başlıkta Türkçe itiraz et (her birini plandaki gerçek metne dayandır):
1. Teknik Riskler: Plandaki teknoloji seçimleri veya mimari kararlardan doğan somut riskler.
2. Kapsam ve Rol İsrafı: Brief'e göre fazladan olan veya eksik olan unsurlar.
3. Önerin: Daha sade ve güvenli bir alternatif.
Kesinlikle standart Türkçe karakterler (ç, ğ, ı, ö, ş, ü) kullan.`;
      break;
    }

    case 'draft_synthesis': {
      // Tur 3: Tur 1 önerileri + Tur 2 itiraz noktaları
      const propSummary = prior
        .filter((p) => p.kind === 'proposal')
        .map((p) => `- ${summarizeTurnForContext(p, 150)}`)
        .join('\n');
      const objSummary = prior
        .filter((p) => p.kind === 'objection')
        .map((p) => `- ${summarizeTurnForContext(p, 180)}`)
        .join('\n');

      contextSection = `Öneriler:\n${propSummary}\n\nİtirazlar:\n${objSummary}`;
      roleInstruction = `Sen PROJE YÖNETİCİSİ (PM) rolündesin. Jenerik selamlaşma yapma. Tur 2'deki itirazları tek tek çözerek tek bir BİRLEŞİK TASLAK PLAN hazırla:
1. İtiraz Değerlendirmesi: Her itiraz için alınan somut karar. Kararlar yalnızca bu projenin brief'i ve önceki turlardaki gerçek itirazlardan türesin.
2. Kapsam Arındırması: Brief dışı uydurma eklentilerin elenmesi.
3. Birleşik Taslak Plan: Teknoloji, Departmanlar (küçük projede en fazla 2 departman) ve Görevler.
Kesinlikle standart Türkçe karakterler (ç, ğ, ı, ö, ş, ü) kullan.`;
      break;
    }

    case 'red_team': {
      // Tur 4: Kırmızı Takım SADECE Tur 3 Birleşik Taslağını inceler!
      const draft = prior.find((p) => p.kind === 'draft_synthesis');
      const draftText = draft ? draft.text : prior.map((p) => p.text).join('\n');

      contextSection = `İncelenecek Taslak Plan:\n${draftText}\n\nAsıl Kullanıcı İsteği (Brief):\n${goal}`;
      roleInstruction = `Sen KIRMIZI TAKIM LİDERİSİN. Görevin taslak planı SAVUNMAK DEĞİL, KIRMAKTIR.

ÖNEMLİ KURAL: Bulgularını SADECE yukarıdaki taslak plan metnine ve brief'e dayandır. Planda geçmeyen kavramları ekleme.
Brief'teki gerçek çelişkileri ve plandaki gerçek sorunları bul:
- Brief 'hem X hem Y' istiyorsa bunların mimaride aynı anda mümkün olup olmadığını sorgula.
- Taslakta belirsiz kalan, araştırılmamış veya riskli unsurları somutlaştır.
- Planda testlenmemiş veya edge case'leri atlanmış alanları işaret et.

En az 3 somut zafiyet yaz, her birini taslak plandaki somut bir cümle veya karara bağla.
Kesinlikle standart Türkçe karakterler (ç, ğ, ı, ö, ş, ü) kullan.`;
      break;
    }

    case 'final_synthesis':
    default: {
      // Tur 5: Taslak + Kırmızı Takım Raporu + Başlıca İtirazlar
      const draft = prior.find((p) => p.kind === 'draft_synthesis');
      const red = prior.find((p) => p.kind === 'red_team');
      const objections = prior.filter((p) => p.kind === 'objection').map((p) => `- ${summarizeTurnForContext(p, 120)}`).join('\n');

      const research = prior.filter((p) => p.kind === 'research').map((p) => `- ${summarizeTurnForContext(p, 220)}`).join('\n');
      const debate = prior.filter((p) => p.kind === 'debate_round').map((p) => `- ${summarizeTurnForContext(p, 220)}`).join('\n');
      contextSection = `Taslak Plan:\n${draft ? draft.text : ''}\n\nKırmızı Takım Raporu:\n${red ? red.text : ''}\n\nAraştırma Bulguları:\n${research || '(Araştırma turu yok)'}\n\nEk Müzakere:\n${debate || '(Ek müzakere yok)'}\n\nİtiraz Özeti:\n${objections}`;
      roleInstruction = `DİL VE KİMLİK KURALI:
- YANITINI KESİNLİKLE VE YALNIZCA TÜRKÇE YAZ. İngilizce veya başka dil KESİNLİKLE YASAKTIR.
- Sen konseyin nihai karar merciisisin (Proje Yöneticisi). Dışarıdan durum anlatan bir gözlemci asla olmayacaksın.
- Kararlarını birinci çoğul şahısla ('Kabul ediyoruz', 'Reddediyoruz') yaz.

GÖREVİN: Kırmızı takımın BU PROJEYİ inceleyen gerçek bulgularından her birini ele al. Brief'teki her çelişkiyi çöz veya 'uzlaşılamadı' de.

ZORUNLU FORMAT (her kırmızı takım bulgusu için):
BULGU N: [Kırmızı takımın bu projeye özgü somut bulgusu]
KARAR: KABUL / RED / KISMI
GEREKÇE: [Bu projenin bağlamında neden bu karar]
PLANA YANSIMASI: [Planda nasıl değişti]

Eğer brief'teki iki gereksinim aynı anda sağlanamıyorsa:
BULGU N: [Çelişki adı]
KARAR: UZLAŞILAMADI
GEREKÇE: [Neden çözümsüz]
ÖNERİ: [Kullanıcıya sunulacak seçenek]

Son olarak NİHAİ DEPARTMANLAR ve GENEL DURUM satırını ekle.

ZORUNLU: Yanıtının SONUNA makine tarafından okunacak iş kırılımını ekle.
Bu bölüm olmadan plan onaylanamaz — onay hiçbir görev üretemez.

## GÖREVLER
### GÖREV g1 — [kısa görev başlığı]
DOSYALAR: [virgülle ayrılmış GERÇEK dosya yolları, en az bir tane]
KABUL: [kriter 1 | kriter 2]
BAĞIMLI: [önceki görev anahtarı ya da -]
GRUP: coding
AÇIKLAMA: [tek cümle]

Kurallar:
- Her görevin EN AZ BİR hedef dosyası olmalı; hedefsiz görev hiçbir şey yazamaz.
- Anahtarlar g1, g2, g3 ... biçiminde olmalı ve BAĞIMLI yalnız daha önce
  tanımlanmış bir anahtara referans verebilir.
- Yalnız bu projede gerçekten yapılacak işleri yaz; uydurma görev ekleme.`;
      break;
    }
  }

  return `DİL KURALI: SADECE VE YALNIZCA TÜRKÇE YAZ.

Hedef: ${goal}

Bağlam:
${contextSection}

Talimat:
${roleInstruction}

Cevap:`;
}

function roleNameFor(member: CouncilMember, members: readonly CouncilMember[]): string {
  const index = members.findIndex((item) => item.agentId === member.agentId);
  const ordinal = index >= 0 ? index + 1 : 1;
  if (member.role === 'pm' || index === 0) return 'Proje Yöneticisi';
  if (member.role === 'researcher') return 'Araştırma Lideri';
  if (member.role === 'red_team') return 'Kırmızı Takım Lideri';
  return `Grup Lideri ${ordinal}`;
}

export class CouncilApplicationService {
  readonly #logger = new Logger(CouncilApplicationService.name);
  readonly #database: ServerDatabase;
  readonly #transport: CouncilTransportSend | undefined;

  constructor(
    @Inject(SERVER_DATABASE) database: ServerDatabase,
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
      const message = councilMessageForTurn(turn);

      const envelope = await communication.send(
        { type: 'agent_capability', credential, issuedAt: new Date().toISOString() } as never,
        {
          projectId,
          sessionId: turn.sessionId,
          recipient: { type: 'agent', id: turn.recipientId },
          kind: message.kind,
          payload: message.payload,
          provenance: { class: 'agent_message', sourceId: `turn-${turn.turnNumber}`, sourceVersion: turn.kind },
          priority: 'normal',
          createdAt: new Date().toISOString(),
          idempotencyKey: `council:${turn.sessionId}:${turn.speakerId}:${turn.kind}:${turn.turnNumber}`,
        } as never,
      );
      return { messageId: String((envelope as { messageId: string }).messageId) };
    };
  }

  async run(
    projectId: string,
    goal: string,
    overrideCompleter?: (input: { member: { agentId: string; modelRef: string }; kind: string; prompt: string }) => Promise<{ text: string }>,
  ): Promise<CouncilRunResult> {
    const trimmedGoal = goal.trim();
    if (trimmedGoal === '') throw new CouncilRunError('konsey hedefi bos olamaz');

    const project = await getLatestProject(this.#database.ch, projectId);
    if (project === null) throw new CouncilRunError('proje bulunamadi');

    const routing = await loadRoutingIndex(this.#database.ch);
    const providerRows = await listLatestApiProviders(this.#database.ch);
    const stubProviders = providerRows
      .filter((row) => row.base_url.trim() === '')
      .map((row) => row.provider_id);
    const agents = await listLatestAgents(this.#database.ch, project.project_id as EntityId);
    const active = agents.filter((agent) => agent.status !== 'stopped');
    const composition = composeCouncil(active.map((agent) => ({
      agentId: agent.agent_id as EntityId,
      modelRef: routing.modelForRole(agent.role) ?? agent.model_ref,
    })), { stubProviders });
    if (composition.diversityWarning !== '') {
      this.#logger.warn(composition.diversityWarning);
    }

    const store = await Keystore.open(resolveKeystoreFile());
    const registry = await buildProviderRegistry(providerRows.map((row) => ({
      provider_id: row.provider_id, base_url: row.base_url,
      enabled: row.enabled, models: row.models, key_ref: row.key_ref,
    })), store);
    const router = new ModelRouter(registry.providers, {
      fallbacks: (modelRef) => routing.fallbacks(modelRef),
      usageSink: chUsageSink(this.#database.ch),
      rateLimiter: new ProviderRateLimiter(() => providerRequestsPerMinute()),
    });

    const sessionId = randomUUID() as EntityId;
    const transcript: { kind: string; text: string; memberId: string; turnNumber: number }[] = [];
    const chair = composition.members[0]!;
    const send = this.#transport ?? await this.#defaultTransport(
      project.project_id as EntityId, active,
    );

    const protocol = new CouncilProtocol({
      send: async (input) => {
        transcript.push({
          kind: input.kind,
          text: input.text,
          memberId: String(input.recipient),
          turnNumber: input.turnNumber,
        });
        return send({
          sessionId: input.sessionId,
          speakerId: input.recipient as EntityId,
          recipientId: chair.agentId,
          kind: input.kind,
          turnNumber: input.turnNumber,
          turnTitle: input.turnTitle,
          text: input.text,
          dissenting: input.dissenting ?? false,
        });
      },
    });

    const result = await protocol.run(
      { sessionId, members: composition.members, prompt: trimmedGoal },
      async ({ kind, turnNumber, member, prior }) => {
        if (overrideCompleter !== undefined) {
          const comp = await overrideCompleter({ member, kind, prompt: buildCouncilTurnPrompt(kind, trimmedGoal, prior, roleNameFor(member as CouncilMember, composition.members)) });
          return { text: comp.text, dissenting: kind === 'red_team' };
        }
        const routed = await router.complete(member.modelRef, {
          messages: [{ role: 'user', content: buildCouncilTurnPrompt(kind, trimmedGoal, prior, roleNameFor(member as CouncilMember, composition.members)) }],
          // Nihai sentez BULGU/KARAR bloklarına EK OLARAK makine okunur bir
          // iş kırılımı taşır; 600 token bunu doldurmaya yetmiyor ve kesik
          // çıktı [SENTEZLEME_BASARISIZ] sayılıyordu.
          maxTokens: kind === 'final_synthesis' ? 1_400 : 600,
          meta: {
            purpose: 'council',
            projectId: project.project_id,
            agentId: member.agentId,
          },
        });
        let text = cleanLlmResponse(routed.result.content ?? '');
        if (text === null || text.trim() === '') {
          // TEK ÜYENİN SESSİZLİĞİ KONSEYİ DÜŞÜRMEZ. Burada fırlatmak iki
          // sorun üretiyordu: (1) bir üyenin boş cevabı tüm oturumu iptal
          // ediyordu, (2) protokolün "bir kez yeniden dene, sonra
          // [KATILMADI] yaz" yedeği üretimde ERİŞİLEMEZ ölü koddu.
          // Boş metni protokole geri veriyoruz; o yeniden dener ve ısrar
          // ederse katılmama olarak kaydeder. Hiçbir üye konuşmazsa
          // protokolün katılım tabanı zaten fırlatır.
          return { text: '' };
        }

        // Dil ve Şablon Doğrulaması (Tur 5 / final_synthesis)
        if (kind === 'final_synthesis') {
          if (isEnglishOrObserverText(text) || !text.includes('BULGU') || !text.includes('KARAR:') || !text.includes('GÖREVLER')) {
            // Tekrar dene
            const retryRouted = await router.complete(member.modelRef, {
              messages: [
                { role: 'user', content: buildCouncilTurnPrompt(kind, trimmedGoal, prior, roleNameFor(member as CouncilMember, composition.members)) },
                { role: 'assistant', content: text },
                { role: 'user', content: "Lütfen yanıtını SADECE TÜRKÇE yaz, BULGU/KARAR/GEREKÇE/PLANA YANSIMASI şablonunu aynen doldur ve sonuna ## GÖREVLER bölümünü zorunlu biçimde ekle." }
              ],
              // Görev kırılımı da bu yanıta sığmalı; 600 token şablonu
              // doldurmaya çoğu zaman yetmiyordu ve kesik çıktı
              // [SENTEZLEME_BASARISIZ] sayılıyordu.
              maxTokens: kind === 'final_synthesis' ? 1_400 : 600,
              meta: { purpose: 'council', projectId: project.project_id, agentId: member.agentId }
            });
            const retryText = cleanLlmResponse(retryRouted.result.content ?? '');
            if (retryText && !isEnglishOrObserverText(retryText) && retryText.includes('BULGU') && retryText.includes('GÖREVLER')) {
              text = retryText;
            } else {
              // Model iki denemede de başarısız — sabit metin YASAK, failed_synthesis işareti koy.
              // Yakınsama döngüsü bunu tespit ederek ek tur açar (H1).
              this.#logger.warn(`[H1] final_synthesis model basarisiz (tur=${turnNumber}), failed_synthesis isaretlendi`);
              text = `[SENTEZLEME_BASARISIZ] Model bu tur için projeye özgü Türkçe sentez üretemedi. Yakınsama döngüsü ek tur açacak.`;
            }
          }
        }
        return { text, dissenting: kind === 'red_team' };
      },
    );

    // H3 — Karar Defterine (ww.decisions) Kaydet
    if (result.decisions && result.decisions.length > 0) {
      for (const item of result.decisions) {
        try {
          await createDecision(this.#database.ch, {
            decision_id: randomUUID() as EntityId,
            project_id: project.project_id as EntityId,
            topic: item.topic,
            decision: item.decision,
            rationale: item.rationale,
            dissent: item.dissent || "",
            turn_number: item.turnNumber,
            created_at: new Date().toISOString(),
          });
        } catch (err) {
          this.#logger.warn(`Karar defteri kaydı başarısız: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    const orgPlan = deriveOrgPlan(project.name, trimmedGoal);

    const existing = [
      ...await listLatestPlansByStatus(this.#database.ch, project.project_id, 'approved'),
      ...await listLatestPlansByStatus(this.#database.ch, project.project_id, 'proposed'),
    ];
    const planVersion = existing.reduce((max, plan) => Math.max(max, plan.plan_version), 0) + 1;
    const planId = randomUUID() as EntityId;

    try {
      const planPayload = buildCouncilPlan({
        projectId: project.project_id as EntityId,
        projectName: project.name,
        planId,
        planVersion,
        sessionId,
        chairAgentId: composition.members[0]!.agentId,
        goal: trimmedGoal,
        proposals: result.proposals.map(p => ({ ...p, dissenting: Boolean(p.dissenting) })),
        objections: result.objections.map(o => ({ ...o, dissenting: Boolean(o.dissenting) })),
        draftSynthesis: result.draftSynthesis as never,
        redTeam: result.redTeam as never,
        finalSynthesis: result.finalSynthesis as never,
        synthesis: { ...result.finalSynthesis, dissenting: Boolean(result.finalSynthesis.dissenting) },
        allTurns: result.allTurns as never,
        convergenceLog: result.convergenceLog as never,
        status: result.status,
        memberModelRefs: composition.members.map((member) => member.modelRef),
        diversityWarning: composition.diversityWarning,
        orgPlan,
        createdAt: new Date().toISOString(),
      });
      this.#logger.log(`createPlan cagriliyor: planId=${planId}`);
      await createPlan(this.#database.ch, planPayload as never);
      this.#logger.log(`createPlan basarili: planId=${planId}`);
    } catch (err) {
      this.#logger.error(`createPlan basarisiz: ${err}`);
      throw err;
    }

    return Object.freeze({
      planId,
      sessionId,
      memberModelRefs: composition.members.map((member) => member.modelRef),
      distinctProviders: composition.distinctProviders,
      diversityWarning: composition.diversityWarning,
      turns: transcript.length,
      status: result.status,
      totalRounds: result.totalRounds,
      decisions: result.decisions,
      convergenceLog: result.convergenceLog,
      orgPlan,
    });
  }
}
