import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const envPath = path.join(repoRoot, '.env');

if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const [key, ...rawValue] = trimmed.split('=');
    if (key !== undefined && process.env[key] === undefined) {
      process.env[key] = rawValue.join('=').trim();
    }
  }
}

const live = process.argv.includes('--live');
const jsonArgIndex = process.argv.indexOf('--json');
const explicitJsonPath = jsonArgIndex >= 0 ? process.argv[jsonArgIndex + 1] : undefined;

const {
  createAgent,
  createCh,
  createProject,
  createRedis,
  listDecisions,
  listMessagesBySession,
} = await import('../packages/db/dist/index.js');
const { NIL_UUID } = await import('../packages/shared/dist/index.js');
const { CouncilApplicationService } = await import('../apps/server/dist/council.service.js');

const goal = 'Tamamen çevrimdışı çalışan (internet olmadan) VE aynı anda canlı çok oyunculu küresel anlık skor tablosu olan bir web oyunu geliştir. Kütüphane desteği belirsizdir ve araştırılması gerekir. Çevrimdışı mimari ile canlı senkronizasyon arasındaki çelişki açıkça ele alınmalıdır.';

const deterministicResponses = {
  proposal: 'Teklif: PWA ile çevrimdışı oynanış, canlı skor için WebSocket/CRDT öneriliyor. Kütüphane desteği belirsiz ve araştırılacak.',
  objection: '1. Teknik Riskler: Tamamen çevrimdışı çalışma ile canlı küresel skor tablosu aynı anda garanti edilemez.\n2. Kapsam ve Rol İsrafı: Express, MongoDB ve Socket.IO küçük web oyunu briefini şişirir.\n3. Önerin: Offline oyun yerel skor tutmalı, canlı skor ayrı çevrimiçi opsiyon olmalı.',
  draft_synthesis: 'Birleşik Taslak: HTML5/CSS/JS local-first oyun. Çevrimdışı oynanış zorunlu. Canlı skor tablosu için çevrimiçi opsiyon kullanıcı onayına bağlıdır.',
  red_team: 'BULGU 1: Çevrimdışı çalışma ile canlı küresel skor tablosu çelişiyor. Tam offline modda gerçek zamanlı küresel skor sağlanamaz.\nBULGU 2: Kütüphane desteği belirsizliği araştırılmadan plan kapatılamaz.\nBULGU 3: Express/MongoDB/Socket.IO kapsamı küçük web oyunu için şişiriyor.',
  research: 'Araştırma: Gerçek zamanlı küresel skor için ağ bağlantısı gerekir. Tam çevrimdışı modda yalnız yerel skor tutulabilir; bağlantı gelirse sonradan eşitleme opsiyonu mümkündür.',
  debate_round: 'Çelişki / İtiraz Analizi: Mutlak çevrimdışı ve gerçek zamanlı küresel skor aynı anda sağlanamaz. Taviz seçenekleri kullanıcıya çıkarılmalıdır.',
  final_synthesis: 'BULGU 1: Çevrimdışı çalışma ile canlı küresel skor tablosu çelişkisi\nKARAR: UZLAŞILAMADI\nGEREKÇE: Tamamen çevrimdışı çalışma ağsız çalışmayı şart koşar; canlı küresel skor tablosu ise ağ bağlantısı ve sunucu gerektirir.\nÖNERİ: Kullanıcı ya tam çevrimdışı + yerel skor seçmeli ya da çevrimiçi modda canlı skor opsiyonunu onaylamalı.\n\nBULGU 2: Kütüphane desteği belirsizliği\nKARAR: KABUL\nGEREKÇE: Araştırma turu gerçek zamanlı skor için ağ bağımlılığını doğruladı.\nPLANA YANSIMASI: Araştırma sonucu planın zorunlu girdisi oldu.\n\nBULGU 3: Kapsam şişmesi\nKARAR: KABUL\nGEREKÇE: Express/MongoDB/Socket.IO başlangıç kapsamı için fazla.\nPLANA YANSIMASI: İlk sürüm HTML5/CSS/JS local-first mimariyle sınırlandı.\n\nGENEL DURUM: UZLAŞILAMADI',
};

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') {
    throw new Error(`${name} ayarlı değil; .env dosyasını veya shell ortamını düzeltin.`);
  }
  return value;
}

function envelopeOf(row) {
  return 'envelope' in row ? row.envelope : row;
}

function messageProof(row) {
  const envelope = envelopeOf(row);
  return {
    turn: envelope.provenance?.sourceId ?? '',
    version: envelope.provenance?.sourceVersion ?? '',
    kind: envelope.kind ?? '',
    text: envelope.payload?.markdown ?? envelope.payload?.summary ?? envelope.payload?.text ?? '',
  };
}

async function createProofProject(ch) {
  const projectId = randomUUID();
  const now = new Date().toISOString();
  const slug = `faz-h-celiski-${projectId.slice(0, 8)}`;
  await createProject(ch, {
    project_id: projectId,
    name: live ? 'Faz H Canlı Çelişki Kanıtı' : 'Faz H Deterministik Çelişki Kanıtı',
    slug,
    type: 'web',
    status: 'planning',
    description: goal,
    workspace_path: path.join(repoRoot, 'workspace', slug),
    budget_usd_limit: 0,
    settings: {},
    active_plan_id: NIL_UUID,
    created_at: now,
    updated_at: now,
  });

  const specs = [
    ['Konsey Üyesi 1', 'ollama:qwen3.6:latest'],
    ['Konsey Üyesi 2', 'ollama:deepseek-coder:33b'],
    ['Konsey Üyesi 3', 'ollama:qwen3.6:latest'],
  ];
  for (const [name, modelRef] of specs) {
    await createAgent(ch, {
      agent_id: randomUUID(),
      project_id: projectId,
      role: 'council_member',
      group: 'management',
      name,
      model_ref: modelRef,
      parent_agent_id: NIL_UUID,
      clone_of: NIL_UUID,
      status: 'idle',
      current_task_id: NIL_UUID,
      prompt_name: 'role.council',
      prompt_version: 1,
      tasks_done: 0,
      tasks_rejected: 0,
      created_at: now,
      updated_at: now,
    });
  }
  return projectId;
}

async function main() {
  requireEnv('WW_LOCAL_SESSION_TOKEN');
  const ch = createCh();
  const redis = await createRedis();
  try {
    const projectId = await createProofProject(ch);
    const service = new CouncilApplicationService({ ch, redis });
    const completer = live
      ? undefined
      : async ({ kind }) => ({ text: deterministicResponses[kind] ?? deterministicResponses.final_synthesis });
    const startedAt = Date.now();
    const result = await service.run(projectId, goal, completer);
    const durationMs = Date.now() - startedAt;
    const messages = await listMessagesBySession(ch, projectId, result.sessionId);
    const decisions = await listDecisions(ch, projectId);
    const proof = {
      mode: live ? 'live' : 'deterministic',
      projectId,
      planId: result.planId,
      sessionId: result.sessionId,
      status: result.status,
      totalRounds: result.totalRounds,
      turnCount: result.turns,
      durationMs,
      convergenceLog: result.convergenceLog ?? [],
      messages: messages.map(messageProof),
      decisions: decisions.map((decision) => ({
        topic: decision.topic,
        decision: decision.decision,
        turnNumber: decision.turn_number,
      })),
    };
    const json = `${JSON.stringify(proof, null, 2)}\n`;
    console.log(json);
    const outputPath = explicitJsonPath
      ? path.resolve(process.cwd(), explicitJsonPath)
      : path.join(repoRoot, 'kanit', `faz_h_contradiction_${proof.mode}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, json);
    console.error(`Kanıt yazıldı: ${outputPath}`);
  } finally {
    await redis.quit();
    await ch.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
