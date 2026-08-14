import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { runMigrations } from '@ww/db';
import { AppModule } from './app.module.js';
import { panelOrigins } from './cors.js';
import { serverPort } from './port.js';

// Açılış sırası (docs/07-zamanlayici.md → Kurtarma): migration → (Faz 2: recovery) → servisler.
async function bootstrap(): Promise<void> {
  const { applied } = await runMigrations();
  if (applied.length) console.log(`[ww] migration uygulandı: ${applied.join(', ')}`);

  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: panelOrigins() });
  const port = serverPort();
  await app.listen(port);
  console.log(`[ww] server hazır: http://localhost:${port}`);
}

void bootstrap();
