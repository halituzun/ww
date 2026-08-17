import { Body, Controller, Get, Inject, Param, Patch, Req } from '@nestjs/common';
import { z } from 'zod';
import { AGENT_ROLES } from '@ww/shared';
import { getLatestRoleModel, listLatestRoleModels, upsertRoleModel } from '@ww/db';
import { loadRoutingIndex } from './routing.loader.js';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';

// docs/04 → Rol→Model Eşleme, docs/08 → API Yönetimi.
// model_ref daima 'provider:model' biçimindedir.
const ModelRef = z.string().trim().regex(/^[a-z0-9_-]+:[A-Za-z0-9._-]+$/, 'model_ref provider:model biçiminde olmalı');

const RoleModelInput = z.strictObject({
  modelRef: ModelRef,
  fallbackRefs: z.array(ModelRef).max(10).default([]),
});

@Controller('role-models')
export class RoleModelsController {
  readonly #database: ServerDatabase;

  constructor(@Inject(SERVER_DATABASE) database: ServerDatabase) {
    this.#database = database;
  }

  /** Tanımlı roller + varsa eşlemeleri; eşlemesi olmayan rol de listelenir. */
  @Get()
  async list() {
    const [rows, routing] = await Promise.all([
      listLatestRoleModels(this.#database.ch),
      loadRoutingIndex(this.#database.ch),
    ]);
    const byRole = new Map(rows.map((row) => [row.role, row]));
    return AGENT_ROLES.map((role) => {
      const row = byRole.get(role);
      const modelRef = row?.model_ref ?? '';
      return {
        role,
        modelRef,
        fallbackRefs: row?.fallback_refs ?? [],
        // Fiilen kullanılacak zincir: pasif sağlayıcılar elenmiş, varsayılan
        // son durak eklenmiş hâli. Yazılan yedekle aynı olmayabilir.
        effectiveChain: modelRef === '' ? [] : routing.fallbacks(modelRef),
        configured: row !== undefined,
        updatedAt: row?.updated_at ?? '',
      };
    });
  }

  @Patch(':role')
  async update(
    @Req() request: LocalSessionRequest,
    @Param('role') role: string,
    @Body() body: unknown,
  ) {
    parseLocalSession(request);
    const input = RoleModelInput.parse(body);
    const saved = await upsertRoleModel(this.#database.ch, {
      role,
      model_ref: input.modelRef,
      fallback_refs: input.fallbackRefs,
      updated_at: new Date().toISOString(),
    });
    return {
      role: saved.role,
      modelRef: saved.model_ref,
      fallbackRefs: saved.fallback_refs,
      configured: true,
      updatedAt: saved.updated_at,
    };
  }

  @Get(':role')
  async get(@Param('role') role: string) {
    const row = await getLatestRoleModel(this.#database.ch, role);
    return row === null
      ? { role, modelRef: '', fallbackRefs: [], configured: false, updatedAt: '' }
      : {
          role: row.role, modelRef: row.model_ref, fallbackRefs: row.fallback_refs,
          configured: true, updatedAt: row.updated_at,
        };
  }
}
