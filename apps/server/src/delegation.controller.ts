import { BadRequestException, Body, Controller, Inject, Injectable, Param, Post, Req } from '@nestjs/common';
import { DelegationError, DelegationService } from '@ww/scheduler';
import { createRedis, enqueueTask, getLatestTask, listLatestAgents, type WwRedis } from '@ww/db';
import { EntityIdSchema, type EntityId } from '@ww/shared';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';
import { createAndEnqueueSubtask, parseSubtaskInput } from './delegation.service.js';

@Injectable()
export class DelegationApplicationService {
  #redis: Promise<WwRedis> | undefined;

  constructor(@Inject(SERVER_DATABASE) private readonly database: ServerDatabase) {}

  #connect(): Promise<WwRedis> {
    this.#redis ??= this.database.redis === undefined
      ? createRedis()
      : Promise.resolve(this.database.redis);
    return this.#redis;
  }

  async create(projectId: string, parentTaskId: string, input: ReturnType<typeof parseSubtaskInput>) {
    const project = EntityIdSchema.parse(projectId);
    const parent = EntityIdSchema.parse(parentTaskId);
    const parentTask = await getLatestTask(this.database.ch, project, parent);
    if (parentTask === null) throw new Error(`üst görev bulunamadı: ${parent}`);

    // Alt görevi AÇAN agent kaydedilir: "kim kime iş verdi" izi budur (docs/08).
    const agents = await listLatestAgents(this.database.ch, project);
    const issuer = agents.find((agent) => agent.agent_id === parentTask.worker_agent_id)
      ?? agents.find((agent) => agent.role === 'pm' && agent.status !== 'stopped');
    if (issuer === undefined) throw new Error('alt görevi açacak agent bulunamadı');

    const service = new DelegationService(this.database.ch);
    const redis = await this.#connect();
    // Delegasyon reddi KULLANICI HATASIDIR (derinlik/bütçe/döngü limiti):
    // 500 "Internal server error" sebebi gizler ve kullanıcı neyi
    // düzelteceğini bilemez.
    try {
      return await createAndEnqueueSubtask({
      createSubtask: (value) => service.createSubtask(value as never) as never,
      enqueue: async (taskProjectId, taskId) => {
        await enqueueTask(redis, `ww:queue:${taskProjectId}`, taskId);
      },
      }, {
      parentTaskId: parent,
      issuerAgentId: issuer.agent_id as EntityId,
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria,
      targetFiles: input.targetFiles,
      group: input.group,
      budget: input.budget,
      dependencies: input.dependencies,
      });
    } catch (reason) {
      if (reason instanceof DelegationError) throw new BadRequestException(reason.message);
      throw reason;
    }
  }
}

@Controller('projects/:projectId/tasks/:taskId/subtasks')
export class DelegationController {
  constructor(@Inject(DelegationApplicationService) private readonly delegation: DelegationApplicationService) {}

  @Post()
  create(
    @Req() request: LocalSessionRequest,
    @Param('projectId') projectId: string,
    @Param('taskId') taskId: string,
    @Body() body: unknown,
  ) {
    parseLocalSession(request);
    return this.delegation.create(projectId, taskId, parseSubtaskInput(body));
  }
}
