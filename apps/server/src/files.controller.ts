import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { BadRequestException, Controller, Get, Inject, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { EntityIdSchema } from '@ww/shared';
import { createProjectMapSnapshot, getProjectMapSourceRef, listFileIndex } from '@ww/db';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';
import { getLatestProject } from '@ww/db';
import { resolveWorkspaceBase, resolveWorkspaceRoot } from './runtime-context.js';
import { resolveWorkspaceFile } from './workspace-file-path.js';
import { buildProjectMap } from './project-map.js';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';

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

  @Get('map')
  async map(@Param('projectId') projectId: string, @Query('limit') limit?: string) {
    const id = EntityIdSchema.parse(projectId);
    const parsedLimit = limit === undefined ? 1_000 : Number(limit);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 5_000) {
      throw new Error('proje haritası limiti geçersiz');
    }
    const project = await getLatestProject(this.database.ch, id);
    if (project === null) throw new Error('proje bulunamadı');
    return buildProjectMap(
      resolveWorkspaceRoot(resolveWorkspaceBase(), project.slug),
      { limit: parsedLimit },
    );
  }

  @Post('map/snapshots')
  async createMapSnapshot(
    @Req() request: LocalSessionRequest,
    @Param('projectId') projectId: string,
    @Query('limit') limit?: string,
  ) {
    parseLocalSession(request);
    const id = EntityIdSchema.parse(projectId);
    const parsedLimit = limit === undefined ? 1_000 : Number(limit);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 5_000) {
      throw new Error('proje haritası limiti geçersiz');
    }
    const project = await getLatestProject(this.database.ch, id);
    if (project === null) throw new Error('proje bulunamadı');
    const map = await buildProjectMap(
      resolveWorkspaceRoot(resolveWorkspaceBase(), project.slug),
      { limit: parsedLimit },
    );
    const now = new Date().toISOString();
    const snapshot = await createProjectMapSnapshot(this.database.ch, {
      project_map_id: randomUUID(),
      project_id: id,
      map_json: map as never,
      file_count: map.fileCount,
      function_count: map.functionCount,
      route_count: map.routeCount,
      generated_at: map.generatedAt,
      created_at: now,
    });
    return {
      snapshot,
      sourceRef: await getProjectMapSourceRef(this.database.ch, id, snapshot.project_map_id),
    };
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
    try {
      const info = await stat(absolute);
      if (!info.isFile()) throw new BadRequestException('yalnızca dosya okunabilir');
      if (info.size > MAX_FILE_BYTES) {
        throw new BadRequestException(`dosya çok büyük: ${info.size} > ${MAX_FILE_BYTES}`);
      }
      return { path: filePath, size: info.size, content: await readFile(absolute, 'utf8') };
    } catch (err) {
      if (err instanceof BadRequestException || err instanceof NotFoundException) throw err;
      if (err && typeof err === 'object' && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        throw new NotFoundException(`dosya bulunamadı: ${filePath}`);
      }
      throw err;
    }
  }
}
