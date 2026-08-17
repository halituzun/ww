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

void bootstrap();
