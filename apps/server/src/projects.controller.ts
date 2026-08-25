import { Body, Controller, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { parseExpressProjectInput, parseProjectInput, parseProjectStatusInput, PROJECT_APPLICATION, type ProjectApplication } from './orchestration.module.js';

@Controller('projects')
export class ProjectsController {
  constructor(@Inject(PROJECT_APPLICATION) private readonly projects: ProjectApplication) {}
  @Post()
  create(@Req() request: LocalSessionRequest, @Body() body: unknown) {
    parseLocalSession(request);
    return this.projects.create(parseProjectInput(body));
  }
  @Post('express')
  expressCreate(@Req() request: LocalSessionRequest, @Body() body: unknown) {
    parseLocalSession(request);
    return this.projects.expressCreate(parseExpressProjectInput(body));
  }
  @Get()
  list() { return this.projects.list(); }
  @Get(':projectId')
  get(@Param('projectId') projectId: string) { return this.projects.get(projectId); }
  @Patch(':projectId/status')
  updateStatus(@Req() request: LocalSessionRequest, @Param('projectId') projectId: string, @Body() body: unknown) {
    parseLocalSession(request);
    return this.projects.updateStatus(projectId, parseProjectStatusInput(body).status);
  }
}
