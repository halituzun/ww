import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { budgetStatus, getLatestProject, readUsageReport } from '@ww/db';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';

const ProjectId = z.string().uuid();
const Days = z.coerce.number().int().min(1).max(365).default(30);

// docs/08 → Kontör Panosu: günlük maliyet, sağlayıcı/model kırılımı,
// en pahalı görevler ve bütçe çubuğu (%80 uyarı çizgisi).
@Controller('projects/:projectId/budget')
export class BudgetController {
  readonly #database: ServerDatabase;

  constructor(@Inject(SERVER_DATABASE) database: ServerDatabase) {
    this.#database = database;
  }

  @Get()
  async report(@Param('projectId') projectId: string, @Query('days') days?: string) {
    const id = ProjectId.parse(projectId);
    const window = Days.parse(days ?? 30);

    const [project, usage] = await Promise.all([
      getLatestProject(this.#database.ch, id),
      readUsageReport(this.#database.ch, id, { days: window }),
    ]);

    const limitUsd = project?.budget_usd_limit ?? 0;
    return {
      ...usage,
      budget: budgetStatus(usage.totals.costUsd, limitUsd),
      windowDays: window,
    };
  }
}
