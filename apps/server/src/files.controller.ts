import { readFile, stat } from 'node:fs/promises';
import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { EntityIdSchema } from '@ww/shared';
import { listFileIndex } from '@ww/db';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';
import { getLatestProject } from '@ww/db';
import { resolveWorkspaceBase, resolveWorkspaceRoot } from './runtime-context.js';
import { resolveWorkspaceFile } from './workspace-file-path.js';

/** Panelde okunabilir üst sınır; büyük dosya tarayıcıyı kilitler. */
const MAX_FILE_BYTES = 512 * 1024;

@Controller('projects/:projectId/files')
export class FilesController {
  constructor(@Inject(SERVER_DATABASE) private readonly database: ServerDatabase) {}

  @Get()
  async list(@Param('projectId') projectId: string, @Query('limit') limit?: string) {
    const id = EntityIdSchema.parse(projectId);
    const parsedLimit = limit === undefined ? 1_000 : Number(limit);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 5_000) {
      throw new Error('file index limiti gecersiz');
    }
    return listFileIndex(this.database.ch, id, parsedLimit);
  }

  /**
   * Dosya İÇERİĞİ (docs/08 → dosya gezgini). Görüntüleyici bugüne dek yer
   * tutucu metin gösteriyordu: "dosyayı görüyorum" sanılıyor ama içerik
   * hiç okunmuyordu. Yol sınırı zorunludur; olmadan bu uç sunucudaki her
   * dosyayı okutur.
   */
  @Get('content')
  async content(
    @Param('projectId') projectId: string,
    @Query('path') filePath?: string,
  ) {
    const id = EntityIdSchema.parse(projectId);
    if (filePath === undefined) throw new Error('path sorgu parametresi zorunludur');
    const project = await getLatestProject(this.database.ch, id);
    if (project === null) throw new Error('proje bulunamadı');

    const root = resolveWorkspaceRoot(
      resolveWorkspaceBase(),
      project.slug,
    );
    const absolute = resolveWorkspaceFile(root, filePath);
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error('yalnızca dosya okunabilir');
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(`dosya çok büyük: ${info.size} > ${MAX_FILE_BYTES}`);
    }
    return { path: filePath, size: info.size, content: await readFile(absolute, 'utf8') };
  }
}
