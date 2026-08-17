import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { createCh, createRedis, runMigrations } from '@ww/db';
import { RecoveryService } from '@ww/memory';
import { panelOrigins } from './cors.js';
import { serverPort } from './port.js';

// Açılış sırası (docs/07-zamanlayici.md → Kurtarma): migration → (Faz 2: recovery) → servisler.
async function bootstrap(): Promise<void> {
  const { applied } = await runMigrations();
  if (applied.length) console.log(`[ww] migration uygulandı: ${applied.join(', ')}`);

  // Faz 2: Redis wakeup kaybolsa bile her proje için durable task state'i
  // yeniden kuyruğa al. Hata startup'ı gizlice başarılı göstermesin.
  const recoveryCh = createCh();
  const recoveryRedis = await createRedis();
  try {
    const recovered = await new RecoveryService(recoveryCh, recoveryRedis).recoverAll();
    const repaired = recovered.reduce((sum, item) => sum + item.requeuedTaskIds.length + item.idledAgentIds.length, 0);
    if (repaired > 0) console.log(`[ww] recovery tamamlandı: ${repaired} kaynak düzeltildi`);
  } finally {
    await recoveryRedis.quit();
    await recoveryCh.close();
  }

  process.env['WW_ENABLE_WS'] ??= '1';

  // ÖNEMLİ: NestFactory.create provider'ları ANINDA kurar ve PHASE8_RUNTIME
  // kayıt yoksa hata fırlatır. Bu yüzden motor kaydı modül kurulmadan ÖNCE
  // yapılmalıdır; canlı koşu bu sıralamayı ortaya çıkardı.
  await tryStartOrchestration();

  const { AppModule } = await import('./app.module.js');
  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableCors({ origin: panelOrigins() });
  // Doğrulama hatası 500 değil 400 olmalı; istemci "girdim hatalı" ile
  // "sunucu bozuldu"yu ayırt edebilsin.
  const { ZodExceptionFilter } = await import('./zod-exception.filter.js');
  app.useGlobalFilters(new ZodExceptionFilter());
  // Sessiz devre dışılık en tehlikeli hata türüdür: /health yeşil olur ama
  // görev kuyruğunu tüketen kimse yoktur. Durumu açılışta yüksek sesle söyle.
  const { runtimeStatus } = await import('./runtime-status.js');
  const { phase9RuntimeConfigFromEnvironment } = await import('./runtime-composition.js');
  const runtime = runtimeStatus(phase9RuntimeConfigFromEnvironment);
  if (runtime.orchestration === 'enabled') {
    console.log('[ww] orkestrasyon runtime: ETKİN — görevler işlenecek');
  } else {
    console.warn(`[ww] UYARI orkestrasyon runtime: ${runtime.orchestration.toUpperCase()} — ${runtime.reason}`);
  }

  const port = serverPort();
  await app.listen(port);
  console.log(`[ww] server hazır: http://localhost:${port}`);
}

/** Orkestrasyon runtime'ını açılışta başlatmayı dener; hata sunucuyu düşürmez. */
async function tryStartOrchestration(): Promise<void> {
  const [
    { startOrchestrationRuntime },
    { bootstrapOrchestrationRuntime },
    { registerPhase9RuntimeConfig },
    { buildProviderRegistry, Keystore },
    { loadRoutingIndex },
    db,
  ] = await Promise.all([
    import('./runtime-starter.js'),
    import('./orchestration-bootstrap.js'),
    import('./runtime-composition.js'),
    import('@ww/providers'),
    import('./routing.loader.js'),
    import('@ww/db'),
  ]);

  const { recordBootstrapReason } = await import('./runtime-status.js');
  const ch = db.createCh();
  const redis = await db.createRedis();
  // Bu bağlantılar kayıt BAŞARILIYSA composition'a devredilir ve sürecin
  // ömrü boyunca yaşamalıdır. Burada kapatmak, kayıtlı motoru kapalı
  // istemcilerle bırakır: her görev "The client is closed" ile düşer ve
  // hiçbir şey tüketilmediği sürece bu görünmez kalır.
  let handedOver = false;
  try {
    const result = await startOrchestrationRuntime({
      enabled: process.env['WW_PHASE8_RUNTIME_ENABLED'] === '1',
      requestedProjectId: process.env['WW_RUNTIME_PROJECT_ID'],
      log: (message) => console.log(message),
      listProjects: async () => {
        const rows = await db.listLatestProjectsByStatus(ch, 'running');
        return rows.map((row) => ({
          project_id: row.project_id, slug: row.slug, status: row.status, name: row.name,
        }));
      },
      bootstrap: async (project) => bootstrapOrchestrationRuntime({
        ch, redis,
        projectId: project.project_id as never,
        projectSlug: project.slug,
        workspaceRoot: process.env['WW_WORKSPACE_ROOT'] ?? `${process.cwd()}/workspace`,
        localSessionToken: process.env['WW_LOCAL_SESSION_TOKEN'] ?? '',
        consumerId: `server-${process.pid}`,
        loadProviders: async () => {
          const store = await Keystore.open(
            process.env['WW_KEYSTORE_FILE'] ?? `${process.cwd()}/.ww/keys.json`,
          );
          const providers = await db.listLatestApiProviders(ch);
          return buildProviderRegistry(providers.map((row) => ({
            provider_id: row.provider_id, base_url: row.base_url,
            enabled: row.enabled, models: row.models, key_ref: row.key_ref,
          })), store);
        },
        loadRouting: () => loadRoutingIndex(ch),
        // bindLate'i kaydın parçası yap: composition kurulunca çağrılır.
        register: registerPhase9RuntimeConfig,
      }),
    });
    if (!result.started) {
      // Sözleşme: bayrak=1 ⟺ kayıtlı. Kayıt olmadıysa bayrağı düşür ki modül
      // kurulumu ölümcül hata vermesin; sunucu ayakta kalsın ve kullanıcı
      // sebebi /runtime'dan görebilsin.
      recordBootstrapReason(result.reason);
      delete process.env['WW_PHASE8_RUNTIME_ENABLED'];
    }
    handedOver = result.started;
  } finally {
    // Yalnızca sahipsiz kalan bağlantılar kapatılır.
    if (!handedOver) {
      await redis.quit();
      await ch.close();
    }
  }
}

void bootstrap();
