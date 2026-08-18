import {
  BadRequestException, Body, Controller, Get, Inject, Param, Patch, Query, Req,
} from '@nestjs/common';
import { z } from 'zod';
import { appendProjectVersion, budgetStatus, getLatestProject, readUsageReport } from '@ww/db';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { BudgetLimitError, decideBudgetLimit } from './budget-limit.js';
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

  /**
   * Bütçe limitini düzenler (docs/08 → "bütçe düzenleme").
   *
   * NEDEN VAR: limit yalnızca proje OLUŞTURULURKEN verilebiliyordu; sonradan
   * değiştirmenin yolu yoktu ve varsayılan 0 (sınırsız) ile açılmış projeye
   * belgelenen bütçe freni panelden hiç kurulamıyordu.
   */
  @Patch()
  async setLimit(
    @Req() request: LocalSessionRequest,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ) {
    parseLocalSession(request);
    const id = ProjectId.parse(projectId);
    const project = await getLatestProject(this.#database.ch, id);
    if (project === null) throw new BadRequestException('proje bulunamadi');

    const usage = await readUsageReport(this.#database.ch, id, { days: 365 });
    try {
      const decision = decideBudgetLimit(
        (body as { limitUsd?: unknown } | null)?.limitUsd,
        usage.totals.costUsd,
      );
      const updated = await appendProjectVersion(this.#database.ch, {
        expectedVersion: project.version,
        next: {
          ...project,
          budget_usd_limit: decision.limitUsd,
          updated_at: new Date().toISOString(),
        },
      });
      return {
        projectId: id,
        limitUsd: updated.budget_usd_limit,
        spentUsd: usage.totals.costUsd,
        // Limit mevcut harcamanın altındaysa proje HEMEN duracaktır; bunu
        // söylemezsek kullanıcı neden durduğunu aramak zorunda kalır.
        alreadyExceeded: decision.alreadyExceeded,
      };
    } catch (reason) {
      if (reason instanceof BudgetLimitError) throw new BadRequestException(reason.message);
      throw reason;
    }
  }
}
