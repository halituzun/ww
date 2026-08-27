// docs/08 → Canlı Tuval: "ilk yük REST GET /projects/:id/canvas".
//
// Bu uç dokümanda ADIYLA tanımlıydı ama hiç yazılmamıştı; panel tuvali
// agent'ları değil görevleri çiziyordu.
import { BadRequestException, NotFoundException, Controller, Get, Inject, Param, Req } from '@nestjs/common';
import { checkHeartbeat, listLatestAgents, listLatestRoleModels, listLatestTasks, listRecentMessages } from '@ww/db';
import { EntityIdSchema, type EntityId } from '@ww/shared';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { buildCanvasProjection } from './canvas-projection.js';
import { loadRoutingIndex } from './routing.loader.js';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';

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

    const roleModels = await listLatestRoleModels(this.database.ch);
    const roleModelMap = new Map(roleModels.map((r) => [r.role, r.model_ref]));
    return buildCanvasProjection(
      agents as never, tasks as never, live, (role) => roleModelMap.get(role),
    );
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
    const aId = EntityIdSchema.safeParse(agentId);
    if (!aId.success) throw new BadRequestException('geçersiz agent kimliği');

    const [agents, tasks, messages] = await Promise.all([
      listLatestAgents(this.database.ch, projectId as EntityId),
      listLatestTasks(this.database.ch, projectId),
      listRecentMessages(this.database.ch, projectId as EntityId, 1000).catch(() => []),
    ]);

    const agent = agents.find((a) => a.agent_id === agentId);
    if (!agent) {
      throw new NotFoundException(`Agent bulunamadı: ${agentId}`);
    }

    const routing = await loadRoutingIndex(this.database.ch);
    const effectiveModel = routing.modelForRole(agent.role) ?? agent.model_ref;

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

    // Mesaj sayısı
    const agentMessages = messages.filter((m) => {
      const from = m.protocolVersion === 1 ? m.envelope.senderPrincipalId : m.fromId;
      return from === agentId;
    });

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
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      calls: 0,
    };
  }
}
