import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, Controller, Get, Inject, Injectable, Param, Post, Req } from '@nestjs/common';
import { createPlan, createRedis, enqueueTask, getLatestProject, listLatestAgents, listLatestPlansByStatus, type WwRedis } from '@ww/db';
import { PlanApprovalError, PlanApprovalService, ReplanningService } from '@ww/scheduler';
import { parseApprovalInput } from './plan-approval.service.js';
import { parseReplanInput } from './replan.service.js';
import type { EntityId } from '@ww/shared';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';
import { buildPlanRow, parsePlanInput } from './plans.service.js';

@Injectable()
export class PlanApplicationService {
  #redis: Promise<WwRedis> | undefined;
  constructor(@Inject(SERVER_DATABASE) private readonly database: ServerDatabase) {}

  async create(projectId: string, input: ReturnType<typeof parsePlanInput>) {
    const project = await getLatestProject(this.database.ch, projectId);
    if (!project) throw new Error('proje bulunamadı');
    const agents = await listLatestAgents(this.database.ch, project.project_id as EntityId);
    // Planı bir agent üretir; sahipsiz plan "bu kararı kim aldı" izini koparır.
    const author = agents.find((agent) => agent.role === 'pm' && agent.status !== 'stopped')
      ?? agents.find((agent) => agent.status !== 'stopped');
    if (!author) throw new Error('proje için aktif agent bulunamadı');

    const row = buildPlanRow({
      projectId: project.project_id as EntityId,
      planId: randomUUID() as EntityId,
      agentId: author.agent_id as EntityId,
      now: new Date().toISOString(),
    }, input);
    return createPlan(this.database.ch, row as never);
  }

  /**
   * Planı onaylar ya da reddeder (docs/08 "plana müdahale"). Servis yazılıydı
   * ama çağıran yoktu: kullanıcı planı ne onaylayabiliyor ne reddedebiliyordu.
   */
  async decide(projectId: string, planId: string, input: ReturnType<typeof parseApprovalInput>) {
    // Onay artık görev ÜRETİR; kuyruk portu olmadan çağrılamaz. Port zorunlu
    // olduğu için "onayladım ama hiçbir şey olmadı" durumu kablolama
    // seviyesinde imkânsızdır.
    const service = new PlanApprovalService(
      this.database.ch,
      {
        enqueue: async (pid, taskId) => {
          this.#redis ??= this.database.redis === undefined
            ? createRedis()
            : Promise.resolve(this.database.redis);
          await enqueueTask(await this.#redis, `ww:queue:${pid}`, taskId);
        },
      },
      { newTaskId: () => randomUUID() as EntityId },
    );
    try {
      const result = await service.apply({
        projectId: projectId as EntityId,
        planId: planId as EntityId,
        approved: input.approved,
        // Kararı KİMİN verdiği iz bırakmalı; onay sahipsiz olamaz.
        actor: 'local-user',
        now: new Date().toISOString(),
        ...(input.note === undefined ? {} : { note: input.note }),
      });
      // Panel bildirimi bu sayıyı OLDUĞU GİBİ söyler; uydurma metin yok.
      return {
        ...result.plan,
        createdTaskCount: result.createdTasks.length,
        createdTaskIds: result.createdTasks.map((task) => task.task_id),
      };
    } catch (reason) {
      // Geçersiz durum geçişi kullanıcı hatasıdır; 500 sebebi gizler.
      if (reason instanceof PlanApprovalError) throw new BadRequestException(reason.message);
      throw reason;
    }
  }

  /** Aktif planı revize eder (docs/03 → yeniden planlama turu). */
  async replan(projectId: string, input: ReturnType<typeof parseReplanInput>) {
    const service = new ReplanningService(this.database.ch);
    try {
      return await service.replan({
        projectId: projectId as EntityId,
        reason: input.reason,
        summary: input.summary,
        now: new Date().toISOString(),
      });
    } catch (reason) {
      // "aktif plan yok" kullanıcı durumudur; 500 sebebi gizler.
      const message = reason instanceof Error ? reason.message : String(reason);
      if (message.includes('aktif plan bulunamadi')) throw new BadRequestException(message);
      throw reason;
    }
  }

  async list(projectId: string) {
    const [proposed, approved, rejected] = await Promise.all([
      listLatestPlansByStatus(this.database.ch, projectId as EntityId, 'proposed'),
      listLatestPlansByStatus(this.database.ch, projectId as EntityId, 'approved'),
      listLatestPlansByStatus(this.database.ch, projectId as EntityId, 'rejected'),
    ]);
    return [...proposed, ...approved, ...rejected];
  }
}

@Controller('projects/:projectId/plans')
export class PlansController {
  constructor(@Inject(PlanApplicationService) private readonly plans: PlanApplicationService) {}

  @Post()
  create(
    @Req() request: LocalSessionRequest,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    parseLocalSession(request);
    return this.plans.create(projectId, parsePlanInput(body));
  }

  @Get()
  list(@Param('projectId') projectId: string) {
    return this.plans.list(projectId);
  }

  @Post('replan')
  replan(
    @Req() request: LocalSessionRequest,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    parseLocalSession(request);
    return this.plans.replan(projectId, parseReplanInput(body));
  }

  @Post(':planId/approval')
  decide(
    @Req() request: LocalSessionRequest,
    @Param('projectId') projectId: string,
    @Param('planId') planId: string,
    @Body() body: unknown,
  ) {
    parseLocalSession(request);
    return this.plans.decide(projectId, planId, parseApprovalInput(body));
  }
}
