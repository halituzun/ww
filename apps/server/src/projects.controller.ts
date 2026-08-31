import { listDecisions } from '@ww/db';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';
import { Body, Controller, Get, Inject, NotFoundException, Param, Patch, Post, Req } from '@nestjs/common';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { parseExpressProjectInput, parseProjectInput, parseProjectStatusInput, PROJECT_APPLICATION, type ProjectApplication } from './orchestration.module.js';

@Controller('projects')
export class ProjectsController {
  constructor(
    @Inject(PROJECT_APPLICATION) private readonly projects: ProjectApplication,
    @Inject(SERVER_DATABASE) private readonly database: ServerDatabase,
  ) {}
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
  @Get(':projectId/decisions')
  async listProjectDecisions(
    @Req() request: LocalSessionRequest,
    @Param('projectId') projectId: string,
  ) {
    parseLocalSession(request);
    return await listDecisions(this.database.ch, projectId);
  }

  @Get(':projectId')
  async get(@Param('projectId') projectId: string) {
    const project = await this.projects.get(projectId);
    if (!project) throw new NotFoundException(`proje bulunamadı: ${projectId}`);
    return project;
  }
  @Patch(':projectId/status')
  updateStatus(@Req() request: LocalSessionRequest, @Param('projectId') projectId: string, @Body() body: unknown) {
    parseLocalSession(request);
    return this.projects.updateStatus(projectId, parseProjectStatusInput(body).status);
  }
}
