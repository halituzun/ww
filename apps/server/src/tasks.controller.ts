import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { parseTaskInput, TASK_APPLICATION, type TaskApplication } from './orchestration.module.js';

@Controller('projects/:projectId/tasks')
export class TasksController {
  constructor(@Inject(TASK_APPLICATION) private readonly tasks: TaskApplication) {}
  @Post()
  create(@Req() request: LocalSessionRequest, @Param('projectId') projectId: string, @Body() body: unknown) {
    parseLocalSession(request);
    return this.tasks.create(projectId, parseTaskInput(body));
  }
  @Get(':taskId')
  get(@Param('projectId') projectId: string, @Param('taskId') taskId: string) { return this.tasks.get(projectId, taskId); }
}
