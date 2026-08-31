// docs/08 → Canlı Tuval: "ilk yük REST GET /projects/:id/canvas".
//
// Bu uç dokümanda ADIYLA tanımlıydı ama hiç yazılmamıştı; panel tuvali
// agent'ları değil görevleri çiziyordu.
import { BadRequestException, NotFoundException, Controller, Get, Inject, Param, Req } from '@nestjs/common';
import { checkHeartbeat, listLatestAgents, listLatestRoleModels, listLatestTasks, listRecentMessages } from '@ww/db';
import { EntityIdSchema, type EntityId, type OrgPlan } from '@ww/shared';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { buildCanvasProjection } from './canvas-projection.js';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';

/**
 * Tuvalin okuduğu mesaj satırı. İki protokol sürümü bir arada yaşıyor:
 * v1 zarfı (`envelope`) ve eski düz alanlar (`from_id`/`to_id`).
 */
interface CanvasMessageRow {
  readonly protocolVersion?: number;
  readonly envelope?: {
    readonly senderPrincipalId?: string;
    readonly recipientPrincipalId?: string;
    readonly payload?: unknown;
  } | undefined;
  readonly from_id?: string;
  readonly fromId?: string;
  readonly to_id?: string;
  readonly toId?: string;
  readonly [key: string]: unknown;
}

@Controller('projects/:projectId')
export class CanvasController {
  constructor(@Inject(SERVER_DATABASE) private readonly database: ServerDatabase) {}

  @Get('canvas')
  async canvas(@Req() request: LocalSessionRequest, @Param('projectId') projectId: string) {
    parseLocalSession(request);
    const id = EntityIdSchema.safeParse(projectId);
    if (!id.success) throw new BadRequestException('geçersiz proje kimliği');
    const [agents, tasks] = await Promise.all([
      listLatestAgents(this.database.ch, projectId as EntityId),
      listLatestTasks(this.database.ch, projectId),
    ]);

    const redis = this.database.redis;
    let live: Set<string> | undefined;
    if (redis !== undefined) {
      live = new Set<string>();
      for (const agent of agents) {
        if (await checkHeartbeat(redis, agent.agent_id)) live.add(agent.agent_id);
      }
    }

    const [roleModels, latestPlans] = await Promise.all([
      listLatestRoleModels(this.database.ch),
      this.database.ch.query({
        query: `SELECT team_json, content_md FROM plans WHERE project_id = {projectId:UUID} ORDER BY created_at DESC LIMIT 1`,
        query_params: { projectId },
        format: 'JSONEachRow',
      }).then((res) => res.json<Record<string, unknown>>()).catch(() => []),
    ]);

    const roleModelMap = new Map(roleModels.map((r) => [r.role, r.model_ref]));
    const projection = buildCanvasProjection(
      agents as never, tasks as never, live, (role) => roleModelMap.get(role),
    );

    let orgPlan: OrgPlan | undefined = undefined;
    const latestPlan = latestPlans[0];
    if (latestPlan !== undefined) {
      try {
        const raw = (latestPlan as { team_json?: unknown }).team_json;
        const team = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const candidate = (team as { org_plan?: unknown } | null)?.org_plan ?? team;
        orgPlan = candidate as OrgPlan;
      } catch {
        // Bozuk team_json tuvali düşürmez; org planı yok sayılır.
      }
    }

    return {
      ...projection,
      orgPlan,
    };
  }

  /** docs/08: Düğüme tıklandığında sağ panelde agent geçmişini gösteren uç */
  @Get('agents/:agentId')
  async agentDetail(
    @Req() request: LocalSessionRequest,
    @Param('projectId') projectId: string,
    @Param('agentId') agentId: string,
  ) {
    parseLocalSession(request);
    const pId = EntityIdSchema.safeParse(projectId);
    if (!pId.success) throw new BadRequestException('geçersiz proje kimliği');
    if (!agentId || typeof agentId !== 'string' || agentId.length > 100) {
      throw new BadRequestException('geçersiz agent kimliği');
    }

    const [agents, tasks, messages] = await Promise.all([
      listLatestAgents(this.database.ch, projectId as EntityId),
      listLatestTasks(this.database.ch, projectId),
      listRecentMessages(this.database.ch, projectId as EntityId, 1000).catch(() => []),
    ]);

    const agent = agents.find((a) => a.agent_id === agentId || a.role === agentId || a.name === agentId);
    if (!agent) {
      throw new NotFoundException(`Agent bulunamadı: ${agentId}`);
    }

    const roleModels = await listLatestRoleModels(this.database.ch);
    const roleModelMap = new Map(roleModels.map((r) => [r.role, r.model_ref]));
    const effectiveModel = roleModelMap.get(agent.role) ?? agent.model_ref;

    // Agent ile ilişkili görevler
    const agentTasks: Array<{
      taskId: string;
      title: string;
      status: string;
      relation: 'issuer' | 'worker' | 'verifier';
    }> = [];

    let tasksDone = 0;
    let tasksRejected = 0;

    for (const t of tasks) {
      if (t.worker_agent_id === agentId) {
        agentTasks.push({ taskId: t.task_id, title: t.title, status: t.status, relation: 'worker' });
        if (t.status === 'done') tasksDone++;
        if (t.status === 'rejected') tasksRejected++;
      } else if (t.verifier_agent_id === agentId) {
        agentTasks.push({ taskId: t.task_id, title: t.title, status: t.status, relation: 'verifier' });
      } else if (t.issuer_agent_id === agentId) {
        agentTasks.push({ taskId: t.task_id, title: t.title, status: t.status, relation: 'issuer' });
      }
    }

    // İki mesaj protokolü bir arada yaşıyor (v1 zarfı ve eski düz alanlar).
    // Alan alan `any` yerine TEK bir yerde genişletiyoruz; aşağıdaki tüm
    // erişimler CanvasMessageRow sözleşmesine bakar.
    const rows = messages as unknown as readonly CanvasMessageRow[];

    // Çift yönlü mesajlar (gönderilen + alınan)
    const agentMessages = rows.filter((m) => {
      const from = m.protocolVersion === 1 ? m.envelope?.senderPrincipalId : m.from_id ?? m.fromId;
      const to = m.protocolVersion === 1 ? m.envelope?.recipientPrincipalId : m.to_id ?? m.toId;
      return from === agentId || to === agentId || from === agent?.role || to === agent?.role;
    });

    const conversationHistory = agentMessages.slice(0, 15).map((m) => {
      const from = m.protocolVersion === 1 ? m.envelope?.senderPrincipalId : String(m.from_id ?? m.fromId ?? 'Bilinmeyen');
      const to = m.protocolVersion === 1 ? m.envelope?.recipientPrincipalId : String(m.to_id ?? m.toId ?? 'Genel');
      const content = m.protocolVersion === 1 ? JSON.stringify(m.payload ?? m.envelope?.payload) : String(m.content ?? m.message ?? '');
      const isOutgoing = from === agentId || from === agent?.role;
      return {
        id: m.message_id || m.messageId || `msg-${Math.random()}`,
        direction: isOutgoing ? 'outgoing' : 'incoming',
        counterpart: isOutgoing ? to : from,
        summary: content.slice(0, 140),
        timestamp: m.created_at || m.createdAt || new Date().toISOString(),
      };
    });

    // API kullanım ve maliyet metrikleri (api_usage tablosundan)
    let promptTokens = 0;
    let completionTokens = 0;
    let costUsd = 0;
    let calls = 0;

    try {
      const usageRes = await this.database.ch.query({
        query: `SELECT count() AS calls, sum(prompt_tokens) AS pt, sum(completion_tokens) AS ct, sum(cost_usd) AS cost FROM api_usage WHERE agent_id = {agentId:UUID}`,
        query_params: { agentId },
        format: 'JSONEachRow',
      });
      const rawJson = (await usageRes.json()) as unknown;
      const rows = Array.isArray(rawJson)
        ? rawJson
        : ((rawJson as { data?: Array<Record<string, unknown>> } | null)?.data ?? []);
      const first = rows[0] as Record<string, unknown> | undefined;
      if (first !== undefined) {
        calls = Number(first.calls ?? 0);
        promptTokens = Number(first.pt ?? 0);
        completionTokens = Number(first.ct ?? 0);
        costUsd = Number(first.cost ?? 0);
      }
    } catch {
      // api_usage tablosu okunamadıysa sessizce 0 kalır
    }

    return {
      agentId: agent.agent_id,
      name: agent.name || agent.role,
      role: agent.role,
      group: agent.group,
      modelRef: effectiveModel,
      status: agent.status,
      tasksDone,
      tasksRejected,
      tasks: agentTasks,
      messageCount: agentMessages.length,
      conversations: conversationHistory,
      promptTokens,
      completionTokens,
      costUsd,
      calls,
    };
  }
}
