import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, Controller, Get, Inject, Injectable, Param, Post, Req } from '@nestjs/common';
import { appendPromptVersion, createAgent, createPlan, createRedis, enqueueTask, getActivePrompt, getLatestProject, listLatestAgents, listLatestPlansByStatus, type PlanRow, type WwRedis } from '@ww/db';
import { NIL_UUID, type OrgPlan } from '@ww/shared';
import { planOrgRoster, rosterCanonicalPromptNames } from './agent-roster.js';
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

  /**
   * Konseyin organizasyon planından agent kadrosunu kurar.
   *
   * NEDEN BURADA: kadro kurulumu kanonik prompt okumasını ve prompt yazımını
   * gerektirir; scheduler paketi bunları bilmez. Planlama SAF fonksiyondadır
   * (agent-roster.ts), burada yalnız okuma/yazma yapılır.
   */
  async #ensureRoster(projectId: EntityId, plan: PlanRow): Promise<number> {
    const rawTeam = typeof plan.team_json === 'string'
      ? (() => { try { return JSON.parse(plan.team_json); } catch { return undefined; } })()
      : plan.team_json;
    const orgPlan = (rawTeam as { org_plan?: OrgPlan } | undefined)?.org_plan;
    // Org planı olmayan plan (ör. bootstrap planı) kadro kurmaz; bu bir hata
    // değil, o planın organizasyon iddiası yoktur.
    if (orgPlan === undefined) return 0;

    const canonical = new Map<string, { prompt_name: string; prompt_version: number; content: string }>();
    for (const name of rosterCanonicalPromptNames(orgPlan)) {
      const active = await getActivePrompt(this.database.ch, name);
      if (active !== null) canonical.set(name, active);
    }

    const existing = await listLatestAgents(this.database.ch, projectId);
    const roster = planOrgRoster({
      projectId,
      orgPlan,
      existingAgentNames: new Set(existing.map((agent) => agent.name)),
      canonical,
    });

    if (roster.missingPrompts.length > 0) {
      // Sessizce yarım kadro kurmak, "kadro kuruldu" demenin yalan biçimidir.
      throw new PlanApprovalError(
        `kadro kurulamadi, kanonik prompt eksik: ${roster.missingPrompts.join(', ')}`,
      );
    }

    const now = new Date().toISOString();
    for (const prompt of roster.prompts) {
      await appendPromptVersion(this.database.ch, { ...prompt, created_at: now } as never);
    }
    for (const agent of roster.agents) {
      await createAgent(this.database.ch, {
        agent_id: randomUUID(),
        project_id: projectId,
        role: agent.role,
        group: agent.group,
        name: agent.name,
        model_ref: agent.model,
        parent_agent_id: NIL_UUID,
        clone_of: NIL_UUID,
        status: 'idle',
        current_task_id: NIL_UUID,
        prompt_name: agent.promptName,
        prompt_version: 1,
        tasks_done: 0,
        tasks_rejected: 0,
        created_at: now,
        updated_at: now,
      } as never);
    }
    return roster.agents.length;
  }

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
      { ensureRoster: (projectId, plan) => this.#ensureRoster(projectId, plan) },
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
        ...(input.acknowledgeLowDiversity === undefined
          ? {}
          : { acknowledgeLowDiversity: input.acknowledgeLowDiversity }),
      });
      // Panel bildirimi bu sayıları OLDUĞU GİBİ söyler; uydurma metin yok.
      return {
        ...result.plan,
        createdTaskCount: result.createdTasks.length,
        createdTaskIds: result.createdTasks.map((task) => task.task_id),
        createdAgentCount: result.createdAgentCount,
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
      const result = await service.replan({
        projectId: projectId as EntityId,
        reason: input.reason,
        summary: input.summary,
        now: new Date().toISOString(),
      });
      // Panel bu değerleri OLDUĞU GİBİ söyler ve konsey turunu `councilGoal`
      // ile başlatır; yeni plan sürümü o turdan doğar.
      return {
        ...result.supersededPlan,
        cancelledTaskCount: result.cancelledTasks.length,
        councilGoal: result.councilGoal,
        nextPlanVersion: result.nextPlanVersion,
      };
    } catch (reason) {
      // "aktif plan yok" kullanıcı durumudur; 500 sebebi gizler.
      const message = reason instanceof Error ? reason.message : String(reason);
      if (message.includes('aktif plan bulunamadi') || message.includes('gerekcesi bos')) {
        throw new BadRequestException(message);
      }
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
