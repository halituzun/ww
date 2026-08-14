import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import {
  DEFAULT_HEALTH_DEPENDENCIES,
  HEALTH_DEPENDENCIES,
  HealthService,
} from './health.service.js';

@Module({
  controllers: [HealthController],
  providers: [
    { provide: HEALTH_DEPENDENCIES, useValue: DEFAULT_HEALTH_DEPENDENCIES },
    HealthService,
  ],
})
export class AppModule {}
