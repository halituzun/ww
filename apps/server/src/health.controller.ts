import { Controller, Get, Inject } from '@nestjs/common';
import type { HealthReport } from '@ww/shared';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get()
  async get(): Promise<HealthReport> {
    return this.health.check();
  }
}
