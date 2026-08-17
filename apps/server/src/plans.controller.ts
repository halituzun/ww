import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Inject, Injectable, Param, Post, Req } from '@nestjs/common';
import { createPlan, getLatestProject, listLatestAgents, listLatestPlansByStatus } from '@ww/db';
import type { EntityId } from '@ww/shared';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';
import { buildPlanRow, parsePlanInput } from './plans.service.js';

@Injectable()
export class PlanApplicationService {
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

  async list(projectId: string) {
    const approved = await listLatestPlansByStatus(this.database.ch, projectId as EntityId, 'approved');
    return approved;
  }
}

@Controller('projects/:projectId/plans')
export class PlansController {
  constructor(private readonly plans: PlanApplicationService) {}

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
}
