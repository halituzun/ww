// docs/08 → tuval etkileşimi: "düğüme tık → yan panelde agent geçmişi
// (görevleri, mesajları, harcadığı token)".
//
// Bu yüzey dokümante ama hiç yazılmamıştı: tuvalde bir agent'a tıklayınca
// gösterilecek hiçbir veri yoktu.
import { Controller, Get, Inject, NotFoundException, Param, Req } from '@nestjs/common';
import { getLatestAgent, readAgentActivity } from '@ww/db';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';

@Controller('projects/:projectId/agents')
export class AgentsController {
  constructor(@Inject(SERVER_DATABASE) private readonly database: ServerDatabase) {}

  @Get(':agentId')
  async detail(
    @Req() request: LocalSessionRequest,
    @Param('projectId') projectId: string,
    @Param('agentId') agentId: string,
  ) {
    parseLocalSession(request);
    const agent = await getLatestAgent(this.database.ch, projectId, agentId);
    if (agent === null) throw new NotFoundException('agent bulunamadi');
    // Kapsam doğrulaması: kimlik bilinse bile başka projenin agent'ı sızmaz.
    if (agent.project_id !== projectId) throw new NotFoundException('agent bu projede degil');

    const activity = await readAgentActivity(this.database.ch, projectId, agentId);
    return {
      // agentId ÖNCE gelir ve activity onu yeniden yazmaz: iki kaynaktan
      // gelen aynı alan sessizce çakışıyordu.
      agentId: agent.agent_id,
      name: agent.name,
      role: agent.role,
      group: agent.group,
      modelRef: agent.model_ref,
      status: agent.status,
      tasksDone: agent.tasks_done,
      tasksRejected: agent.tasks_rejected,
      tasks: activity.tasks,
      messageCount: activity.messageCount,
      promptTokens: activity.promptTokens,
      completionTokens: activity.completionTokens,
      costUsd: activity.costUsd,
      calls: activity.calls,
    };
  }
}
