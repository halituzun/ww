import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { activatePromptVersion, appendPromptVersion, getActivePrompt, listPromptVersions } from '@ww/db';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';
import { nextPromptVersion, parseNewVersionInput } from './prompts.service.js';

/**
 * Prompt sürümleri (docs/03 → şablonlar DB'de, sürümlü, panelden düzenlenebilir).
 *
 * Hiç uç yoktu: promptlar ne listelenebiliyor ne yeni sürüm eklenebiliyor ne
 * de aktif sürüm değiştirilebiliyordu. Brief prompt sürümünü MÜHÜRLEDİĞİ için
 * bu, "hangi talimatla çalışıyoruz" sorusunu ürün üzerinden cevapsız bırakır.
 */
@Controller('prompts')
export class PromptsController {
  constructor(@Inject(SERVER_DATABASE) private readonly database: ServerDatabase) {}

  @Get(':name')
  async versions(@Param('name') name: string) {
    const rows = await listPromptVersions(this.database.ch, name);
    if (rows.length === 0) throw new NotFoundException(`prompt bulunamadı: ${name}`);
    const active = await getActivePrompt(this.database.ch, name);
    return {
      name,
      activeVersion: active?.prompt_version ?? null,
      versions: rows.map((row) => ({
        version: row.prompt_version,
        isActive: row.is_active,
        changelog: row.changelog,
        createdAt: row.created_at,
        // İçerik listede taşınmaz; uzun şablonlar listeyi kullanılmaz kılar.
        contentLength: row.content.length,
      })),
    };
  }

  @Post(':name/versions')
  async create(
    @Req() request: LocalSessionRequest,
    @Param('name') name: string,
    @Body() body: unknown,
  ) {
    parseLocalSession(request);
    const input = parseNewVersionInput(body);
    const existing = await listPromptVersions(this.database.ch, name);
    const version = nextPromptVersion(existing);
    const now = new Date().toISOString();
    try {
      const row = await appendPromptVersion(this.database.ch, {
        prompt_name: name,
        prompt_version: version,
        content: input.content,
        variables: input.variables,
        changelog: input.changelog,
        // Yazmak ile canlıya almak ayrı kararlar; varsayılan pasiftir.
        is_active: false,
        created_at: now,
      });
      if (input.activate) await activatePromptVersion(this.database.ch, name, version, now);
      return { ...row, activated: input.activate };
    } catch (reason) {
      throw new BadRequestException(reason instanceof Error ? reason.message : String(reason));
    }
  }

  @Post(':name/versions/:version/activate')
  async activate(
    @Req() request: LocalSessionRequest,
    @Param('name') name: string,
    @Param('version') version: string,
  ) {
    parseLocalSession(request);
    const parsed = Number(version);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new BadRequestException(`geçersiz prompt sürümü: ${version}`);
    }
    try {
      return await activatePromptVersion(this.database.ch, name, parsed, new Date().toISOString());
    } catch (reason) {
      // Olmayan sürümü aktifleştirmek kullanıcı hatasıdır.
      throw new BadRequestException(reason instanceof Error ? reason.message : String(reason));
    }
  }
}
