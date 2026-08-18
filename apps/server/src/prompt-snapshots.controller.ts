// Mühürlü prompt girdisinin okunması (docs/06 → provenance; docs/02 →
// prompt_input_snapshots).
//
// NEDEN VAR: `api_usage.prompt_input_snapshot_id` her çağrıda doluydu ama
// `prompt_input_snapshots` tablosu BOŞTU — canlı veritabanında 216 çağrı var
// olmayan bir kayda işaret ediyordu. Anlık görüntü artık yazılıyor; bu uç onu
// okunur kılar, yoksa "bu çıktıyı hangi prompt üretti" sorusu yine
// cevapsız kalırdı.
import { Controller, Get, Inject, NotFoundException, Param, Req } from '@nestjs/common';
import { getPromptInputSnapshot } from '@ww/db';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';

@Controller('projects/:projectId/prompt-snapshots')
export class PromptSnapshotsController {
  constructor(@Inject(SERVER_DATABASE) private readonly database: ServerDatabase) {}

  @Get(':snapshotId')
  async detail(
    @Req() request: LocalSessionRequest,
    @Param('projectId') projectId: string,
    @Param('snapshotId') snapshotId: string,
  ) {
    parseLocalSession(request);
    const snapshot = await getPromptInputSnapshot(this.database.ch, snapshotId);
    if (snapshot === null) throw new NotFoundException('prompt anlik goruntusu bulunamadi');
    // Kapsam doğrulaması: prompt'lar iş sırlarını taşır, kimlik bilinse bile
    // başka projeninki sızmamalıdır.
    if (snapshot.projectId !== projectId) {
      throw new NotFoundException('prompt anlik goruntusu bu projede degil');
    }
    return snapshot;
  }
}
