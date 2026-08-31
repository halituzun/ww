import { Controller, Get } from '@nestjs/common';
import { runtimeStatus, type RuntimeStatus } from './runtime-status.js';
import { phase9RuntimeConfigFromEnvironment } from './runtime-composition.js';

/**
 * Orkestrasyon runtime durumu ayrı bir uçta durur: /health yanıt şekli
 * bilinçli olarak sabitlenmiş bir sözleşmedir (health.e2e testi bunu korur),
 * bu yüzden genişletilmedi.
 */
@Controller('runtime')
export class RuntimeController {
  @Get()
  status(): RuntimeStatus {
    return runtimeStatus(phase9RuntimeConfigFromEnvironment);
  }
}
