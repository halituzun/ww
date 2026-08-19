import { Controller, Get, Inject, Req } from '@nestjs/common';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { CliproxyApiService } from './cliproxyapi.service.js';

@Controller('gateway/cliproxy')
export class CliproxyApiController {
  constructor(@Inject(CliproxyApiService) private readonly gateway: CliproxyApiService) {}

  @Get()
  status(@Req() request: LocalSessionRequest) {
    parseLocalSession(request);
    return this.gateway.status();
  }
}
