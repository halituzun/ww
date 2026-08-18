// Proje önizleme süreci (docs/05 → Dev-Server Yaşam Döngüsü; docs/11 Faz 6).
//
// NEDEN VAR: panelin önizleme sekmesi sabit bir `VITE_PREVIEW_URL` env
// değişkenine bakıyor, yoksa `about:blank` gösteriyordu — projeye bağlı
// "canlı önizleme" diye bir şey yoktu. docs/05 proje başına adlandırılmış
// süreç, 42000-42999 port havuzu ve "son 200 satır log" tanımlıyor.
//
// SINIR (dürüstçe): sandbox'ta ağ erişimi olmadığı için bağımlılık kurulamaz;
// bu yüzden önizleme bir paketleyici değil, çalışma alanını servis eden
// bağımlılıksız bir STATİK sunucudur. Üretilen proje statik çıktı veriyorsa
// gerçek uygulamayı gösterir; aksi halde dosya listesini gösterir. Sahte bir
// "çalışıyor" görüntüsü vermemek için bu durum durum bilgisinde belirtilir.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { appendProjectVersion, getLatestProject } from '@ww/db';
import { OutputRing, PORT_POOL_END, PORT_POOL_START, PortPool } from './process-pool.js';
import { readDevPort, withDevPort, withoutDevPort } from './preview-port-store.js';
import { resolveWorkspaceRoot } from './runtime-context.js';
import { SERVER_DATABASE, type ServerDatabase } from './orchestration.module.js';

export class PreviewError extends Error {}

export interface PreviewStatus {
  readonly projectId: string;
  readonly running: boolean;
  readonly port: number | undefined;
  readonly url: string | undefined;
  /** Statik kök gerçek bir uygulama mı yoksa yalnız dosya listesi mi. */
  readonly hasIndexHtml: boolean;
  readonly logs: readonly string[];
}

interface Running {
  readonly child: ChildProcess;
  readonly port: number;
  readonly ring: OutputRing;
  readonly hasIndexHtml: boolean;
}

@Injectable()
export class PreviewApplicationService implements OnModuleDestroy {
  readonly #logger = new Logger(PreviewApplicationService.name);
  readonly #database: ServerDatabase;
  readonly #pool = new PortPool();
  readonly #running = new Map<string, Running>();

  constructor(@Inject(SERVER_DATABASE) database: ServerDatabase) {
    this.#database = database;
  }

  async #workspaceOf(projectId: string): Promise<string> {
    const project = await getLatestProject(this.#database.ch, projectId);
    if (project === null) throw new PreviewError('proje bulunamadi');
    return resolveWorkspaceRoot(
      process.env['WW_WORKSPACE_ROOT'] ?? `${process.cwd()}/workspace`,
      project.slug,
    );
  }

  async start(projectId: string): Promise<PreviewStatus> {
    const existing = this.#running.get(projectId);
    // Zaten çalışan süreci yeniden başlatmak portu ve logları koparırdı.
    if (existing !== undefined && existing.child.exitCode === null) return this.status(projectId);

    const project = await getLatestProject(this.#database.ch, projectId);
    if (project === null) throw new PreviewError('proje bulunamadi');
    const root = await this.#workspaceOf(projectId);
    if (!existsSync(root)) throw new PreviewError(`calisma alani bulunamadi: ${root}`);
    // Önce KAYITLI portu dene: süreç yeniden başlayınca portun değişmesi
    // paneldeki iframe'i sessizce kırar (docs/05 portu projeye yazmayı
    // bu yüzden şart koşuyor).
    const port = this.#pool.assign(projectId, readDevPort(project.settings, PORT_POOL_START, PORT_POOL_END));
    const ring = new OutputRing();
    const hasIndexHtml = existsSync(join(root, 'index.html'));

    // Bağımlılıksız statik sunucu: sandbox'ta paket kurulamaz.
    const child = spawn(process.execPath, ['-e', STATIC_SERVER_SOURCE, root, String(port)], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => ring.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => ring.push(chunk.toString()));
    child.on('exit', (code) => {
      ring.push(`önizleme süreci kapandı (kod ${code ?? 'bilinmiyor'})`);
      this.#logger.log(`önizleme kapandı: ${projectId}`);
    });

    this.#running.set(projectId, { child, port, ring, hasIndexHtml });
    // Port PROJEYE yazılır: bellek süreç ömründen uzun yaşamaz.
    await appendProjectVersion(this.#database.ch, {
      expectedVersion: project.version,
      next: {
        ...project,
        settings: withDevPort(project.settings, port) as never,
        updated_at: new Date().toISOString(),
      },
    });
    this.#logger.log(`önizleme açıldı: ${projectId} → http://localhost:${port}`);
    return this.status(projectId);
  }

  async stop(projectId: string): Promise<PreviewStatus> {
    const running = this.#running.get(projectId);
    if (running !== undefined) {
      running.child.kill('SIGTERM');
      this.#running.delete(projectId);
      this.#pool.release(projectId);
      // Kayıt "çalışıyor" yalanını söylememeli: durdurulan önizlemenin portu
      // projeden silinir.
      try {
        const project = await getLatestProject(this.#database.ch, projectId);
        if (project !== null) {
          await appendProjectVersion(this.#database.ch, {
            expectedVersion: project.version,
            next: {
              ...project,
              settings: withoutDevPort(project.settings) as never,
              updated_at: new Date().toISOString(),
            },
          });
        }
      } catch (reason) {
        // Süreç ZATEN durduruldu; kayıt temizliği düşse bile onu geri
        // döndürmeyiz, yalnızca bildiririz.
        this.#logger.warn(`önizleme portu kaydı silinemedi: ${String(reason)}`);
      }
    }
    return {
      projectId, running: false, port: undefined, url: undefined,
      hasIndexHtml: false, logs: running?.ring.lines() ?? [],
    };
  }

  status(projectId: string): PreviewStatus {
    const running = this.#running.get(projectId);
    if (running === undefined || running.child.exitCode !== null) {
      return {
        projectId, running: false, port: undefined, url: undefined,
        hasIndexHtml: false, logs: running?.ring.lines() ?? [],
      };
    }
    return {
      projectId,
      running: true,
      port: running.port,
      url: `http://localhost:${running.port}/`,
      hasIndexHtml: running.hasIndexHtml,
      logs: running.ring.lines(),
    };
  }

  /** Sunucu kapanırken süreçler bırakılmaz: yetim süreç portu tutar. */
  onModuleDestroy(): void {
    for (const [projectId] of this.#running) void this.stop(projectId);
  }
}

/** Bağımlılıksız statik dosya sunucusu; çalışma alanının DIŞINA çıkamaz. */
const STATIC_SERVER_SOURCE = `
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[1]);
const port = Number(process.argv[2]);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.ts': 'text/plain', '.tsx': 'text/plain', '.md': 'text/plain' };
http.createServer((req, res) => {
  const requested = decodeURIComponent((req.url || '/').split('?')[0]);
  const target = path.resolve(root, '.' + requested);
  // Çalışma alanının dışına çıkan istek reddedilir.
  if (target !== root && !target.startsWith(root + path.sep)) {
    res.writeHead(403); res.end('disari cikilamaz'); return;
  }
  let file = target;
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    const index = path.join(file, 'index.html');
    if (fs.existsSync(index)) file = index;
    else {
      const entries = fs.readdirSync(file, { recursive: true }).map(String);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>Proje dosyalari</h1><ul>' +
        entries.map((e) => '<li><a href="/' + e + '">' + e + '</a></li>').join('') + '</ul>');
      console.log(req.method + ' ' + requested + ' 200 (dizin listesi)');
      return;
    }
  }
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('bulunamadi'); console.log(req.method + ' ' + requested + ' 404'); return; }
  res.writeHead(200, { 'content-type': (TYPES[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
  res.end(fs.readFileSync(file));
  console.log(req.method + ' ' + requested + ' 200');
}).listen(port, () => console.log('onizleme sunucusu hazir: ' + port));
`;
