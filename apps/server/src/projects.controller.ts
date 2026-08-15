import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { parseProjectInput, PROJECT_APPLICATION, type ProjectApplication } from './orchestration.module.js';

@Controller('projects')
export class ProjectsController {
  constructor(@Inject(PROJECT_APPLICATION) private readonly projects: ProjectApplication) {}
  @Post()
  create(@Req() request: LocalSessionRequest, @Body() body: unknown) {
    parseLocalSession(request);
    return this.projects.create(parseProjectInput(body));
  }
  @Get(':projectId')
  get(@Param('projectId') projectId: string) { return this.projects.get(projectId); }
}
