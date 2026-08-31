// Üretilen çıktının detayı (docs/08 → fihrist: "ilişkili işler/kararlar";
// docs/02 → artifacts).
//
// NEDEN VAR: `file_index.related_artifact_ids` doğru dolduruluyor ve
// `getArtifact` yazılıp test edilmişti, ama HİÇBİR üretim yolu onu
// çağırmıyordu — kullanıcı bir dosyadan onu üreten çıktı kaydına
// gidemiyordu. Fihristin "ilişkili" listesi tıklanamayan kimliklerdi.
import { Controller, Get, Inject, NotFoundException, Param, Req } from '@nestjs/common';
import { getArtifact } from '@ww/db';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';

@Controller('projects/:projectId/artifacts')
export class ArtifactsController {
  constructor(@Inject(SERVER_DATABASE) private readonly database: ServerDatabase) {}

  @Get(':artifactId')
  async detail(
    @Req() request: LocalSessionRequest,
    @Param('projectId') projectId: string,
    @Param('artifactId') artifactId: string,
  ) {
    parseLocalSession(request);
    const row = await getArtifact(this.database.ch, artifactId);
    if (row === null) throw new NotFoundException('artifact bulunamadi');
    // Başka projenin çıktısını sızdırmamak için proje kimliği doğrulanır;
    // kimlik bilinse bile kapsam dışına çıkılamaz.
    if (row.project_id !== projectId) throw new NotFoundException('artifact bu projede degil');
    return {
      artifactId: row.artifact_id,
      taskId: row.task_id,
      agentId: row.agent_id,
      type: row.artifact_type,
      name: row.name,
      path: row.path,
      summary: row.summary,
      commitHash: row.commit_hash,
      createdAt: row.created_at,
    };
  }
}
