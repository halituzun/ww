import { Body, Controller, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { listLatestApiProviders, getLatestApiProvider, upsertApiProvider } from '@ww/db';
import { Keystore, maskKey } from '@ww/providers';
import { parseLocalSession, type LocalSessionRequest } from './auth/local-session.js';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';

const ProviderInput = z.strictObject({ displayName: z.string().trim().min(1).max(120), baseUrl: z.string().url().or(z.literal('')), models: z.array(z.string().trim().min(1)).max(100), enabled: z.boolean().default(true), isDefault: z.boolean().default(false), fallbackOrder: z.number().int().min(0).max(255).default(0) });
const KeyInput = z.strictObject({ apiKey: z.string().trim().min(8).max(500) });

@Controller('providers')
export class ProvidersController {
  readonly #database: ServerDatabase;
  #keyStorePromise: Promise<Keystore> | undefined;
  constructor(@Inject(SERVER_DATABASE) database: ServerDatabase) { this.#database = database; }
  #keyStore(): Promise<Keystore> {
    this.#keyStorePromise ??= Keystore.open(process.env['WW_KEYSTORE_FILE'] ?? `${process.cwd()}/.ww/keys.json`);
    return this.#keyStorePromise;
  }

  @Get()
  async list() {
    const providers = await listLatestApiProviders(this.#database.ch);
    const keyStore = await this.#keyStore();
    return Promise.all(providers.map(async (provider) => { const key = provider.key_ref === '' ? undefined : await keyStore.get(provider.key_ref); return { ...provider, keyConfigured: key !== undefined && key.length > 0, maskedKey: key === undefined ? '' : maskKey(key) }; }));
  }

  @Patch(':providerId')
  async update(@Req() request: LocalSessionRequest, @Param('providerId') providerId: string, @Body() body: unknown) {
    parseLocalSession(request);
    const input = ProviderInput.parse(body);
    const current = await getLatestApiProvider(this.#database.ch, providerId);
    const now = new Date().toISOString();
    return upsertApiProvider(this.#database.ch, { provider_id: providerId, display_name: input.displayName, base_url: input.baseUrl, enabled: input.enabled, is_default: input.isDefault, fallback_order: input.fallbackOrder, models: input.models, key_ref: current?.key_ref ?? '', health_status: current?.health_status ?? 'unknown', last_health_check: current?.last_health_check ?? now, updated_at: now });
  }

  @Post(':providerId/key')
  async setKey(@Req() request: LocalSessionRequest, @Param('providerId') providerId: string, @Body() body: unknown) {
    parseLocalSession(request);
    const { apiKey } = KeyInput.parse(body);
    const store = await this.#keyStore();
    await store.set(providerId, apiKey);
    const current = await getLatestApiProvider(this.#database.ch, providerId);
    if (current !== null) await upsertApiProvider(this.#database.ch, { ...current, key_ref: providerId, updated_at: new Date().toISOString() });
    return { providerId, configured: true, maskedKey: maskKey(apiKey) };
  }
}
