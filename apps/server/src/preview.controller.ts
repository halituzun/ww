// docs/10 → web önizleme; docs/11 Faz 6.
//
// Önizleme bu uçlar olmadan projeye bağlanamıyordu: panel sabit bir env
// değişkenine bakıyor, yoksa about:blank gösteriyordu.
import { BadRequestException, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { PreviewApplicationService, PreviewError } from './preview.service.js';

@Controller('projects/:projectId/preview')
export class PreviewController {
  constructor(private readonly preview: PreviewApplicationService) {}

  @Get()
  status(@Req() request: LocalSessionRequest, @Param('projectId') projectId: string) {
    parseLocalSession(request);
    // Durum yoklaması aynı zamanda docs/10 kuralını UYGULAR: duraklatılmış
    // projenin süreci kapatılır. Ayrı bir zamanlayıcı kurmak yerine mevcut
    // yoklamaya bağlamak, kuralı bir bileşenin ömrüne bağlamaz.
    return this.preview.enforceLifecycle(projectId);
  }

  @Post('start')
  async start(@Req() request: LocalSessionRequest, @Param('projectId') projectId: string) {
    parseLocalSession(request);
    try {
      return await this.preview.start(projectId);
    } catch (reason) {
      // Yapılandırma hatası 500 vermemeli: "sunucu bozuk" yalanı olurdu.
      if (reason instanceof PreviewError) throw new BadRequestException(reason.message);
      throw reason;
    }
  }

  @Post('stop')
  async stop(@Req() request: LocalSessionRequest, @Param('projectId') projectId: string) {
    parseLocalSession(request);
    return await this.preview.stop(projectId);
  }
}
