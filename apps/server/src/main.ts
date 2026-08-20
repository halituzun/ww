import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { createCh, createRedis, runMigrations } from '@ww/db';
import { RecoveryService } from '@ww/memory';
import { CommandRunner, resetWorkingTree } from '@ww/executor';
import { appendKnowledgeVersion, getLatestKnowledge, getLatestProject } from '@ww/db';
import { resolveWorkspaceRoot } from './runtime-context.js';
import { resetRecoveredWorkspaces } from './workspace-recovery.js';
import { seedStandardKnowledgeForProjects } from './standard-knowledge.js';
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

    // docs/01 madde 3: çökmeden kalan yarım dosyalar temizlenir. Yapılmazsa
    // sonraki deneme KİRLİ ağaçtan başlar; worker yarım dosya okur, kapı
    // bayat içerikle koşar ve commit önceki denemeden artık taşır.
    await resetRecoveredWorkspaces({
      results: recovered as never,
      loadProject: (projectId) => getLatestProject(recoveryCh, projectId),
      reset: async (projectKey, slug) => {
        const root = resolveWorkspaceRoot(
          process.env['WW_WORKSPACE_ROOT'] ?? `${process.cwd()}/workspace`,
          slug,
        );
        await resetWorkingTree(new CommandRunner(), projectKey, root);
        console.log(`[ww] çalışma ağacı temizlendi: ${slug}`);
      },
      onError: (reason) => console.warn(`[ww] çalışma ağacı temizlenemedi: ${String(reason)}`),
    });

    // docs/06 sabit çekirdeği kod standartlarını `knowledge`'dan alır ve
    // canlı veride kind='standard' olan SIFIR satır vardı: hiçbir worker
    // prompt'u standartları içermiyordu, ama denetçi yine de o
    // standartlardan bulgu açıyordu. Tohumlama fikirsizce tekrarlanabilir
    // (deterministik kimlik; içerik aynıysa yeni sürüm yazılmaz).
    await seedStandardKnowledgeForProjects(
      {
        appendKnowledgeVersion: (row, expectedVersion) =>
          appendKnowledgeVersion(recoveryCh, row as never, expectedVersion),
        getLatestKnowledge: (projectId, knowledgeId) =>
          getLatestKnowledge(recoveryCh, projectId, knowledgeId),
      },
      recovered.map((item) => item.projectId),
      new Date().toISOString(),
      (projectId, reason) =>
        console.warn(`[ww] ${projectId} standartları yazılamadı: ${String(reason)}`),
    );
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
    { buildProviderRegistry, Keystore, resolveKeystoreFile },
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
  // Açılış öz-denetimi: yanlış çözülen keystore yolu eskiden ilk sağlık
  // ping'ine kadar sessiz no_key olarak kalıyordu. Hangi dosyanın
  // kullanıldığı ve kaç kaydın çözülebildiği açılışta görünür olsun.
  // (Keychain geçici hatası sunucuyu düşürmemeli: yalnızca uyar.)
  try {
    const keystoreFile = resolveKeystoreFile();
    const keyRefs = await (await Keystore.open(keystoreFile)).listProviders();
    console.log(`[ww] keystore: ${keyRefs.length} kayıt (${keyRefs.join(', ') || 'yok'}) @ ${keystoreFile}`);
  } catch (err) {
    console.warn(`[ww] keystore açılışta okunamadı: ${err instanceof Error ? err.message : String(err)}`);
  }
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
          const store = await Keystore.open(resolveKeystoreFile());
          const providers = await db.listLatestApiProviders(ch);
          const records = providers.map((row) => ({
            provider_id: row.provider_id, base_url: row.base_url,
            enabled: row.enabled, models: row.models, key_ref: row.key_ref,
          }));
          const cliproxyKey = process.env['WW_CLIPROXY_API_KEY']?.trim() ?? '';
          const cliproxyEnabled = process.env['WW_CLIPROXY_ENABLED'] === '1' && cliproxyKey.length > 0;
          if (cliproxyEnabled) {
            records.push({
              provider_id: 'cliproxyapi',
              base_url: `${(process.env['WW_CLIPROXY_BASE_URL'] ?? 'http://127.0.0.1:8317').replace(/\/+$/, '')}/v1`,
              enabled: true,
              models: [],
              key_ref: '__ww_cliproxyapi_env__',
            });
          }
          return buildProviderRegistry(records, {
            get: async (keyRef) => keyRef === '__ww_cliproxyapi_env__' ? cliproxyKey : store.get(keyRef),
          });
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
