import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../../.env");
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [k, ...v] = trimmed.split("=");
    if (k && v) {
      process.env[k.trim()] = v.join("=").trim();
    }
  }
}

import { createCh } from "@ww/db";
import { randomUUID } from "node:crypto";
import { CouncilApplicationService } from "./dist/council.service.js";

async function main() {
  const ch = createCh();
  
  const projectId = randomUUID();
  const now = new Date().toISOString();
  
  console.log("1. PROJE OLUŞTURULUYOR:", projectId);
  await ch.insert({
    table: "projects",
    values: [{
      project_id: projectId,
      name: "Çevrimdışı ve Canlı Skor Oyunu (Faz H Çelişki Testi)",
      slug: `cevrimdisi-canli-skor-${projectId.slice(0, 8)}`,
      type: "web",
      source_type: "scratch",
      status: "planning",
      created_at: now,
      updated_at: now
    }],
    format: "JSONEachRow"
  });

  const a1 = randomUUID(), a2 = randomUUID(), a3 = randomUUID();
  const agents = [
    { 
      agent_id: a1, project_id: projectId, role: "group_lead", group: "management",
      model_ref: "ollama:qwen3.6:latest", status: "idle", tier: "medium",
      prompt_template: "", tools: [], created_at: now, updated_at: now 
    },
    { 
      agent_id: a2, project_id: projectId, role: "standards_auditor", group: "ui_audit",
      model_ref: "ollama:deepseek-coder:33b", status: "idle", tier: "medium",
      prompt_template: "", tools: [], created_at: now, updated_at: now 
    },
    { 
      agent_id: a3, project_id: projectId, role: "worker", group: "coding",
      model_ref: "ollama:deepseek-coder:33b", status: "idle", tier: "medium",
      prompt_template: "", tools: [], created_at: now, updated_at: now 
    }
  ];
  await ch.insert({ table: "agents", values: agents, format: "JSONEachRow" });
  console.log("2. 3 AJAN CLICKHOUSE'A EKLENDİ.");

  const goal = "Tamamen çevrimdışı çalışan (internet olmadan) VE aynı anda canlı çok oyunculu küresel anlık skor tablosu olan bir web oyunu geliştir. Kütüphane desteği belirsizdir ve araştırılması gerekir. Çevrimdışı mimari ile canlı senkronizasyon arasındaki çelişki açıkça ele alınmalıdır.";

  console.log("3. DİNAMİK KONSEY MÜZAKERESİ BAŞLATILIYOR...");
  console.log("   Brief:", goal);
  const t0 = Date.now();
  const council = new CouncilApplicationService({ ch });
  
  const result = await council.run(projectId, goal);
  const duration = ((Date.now() - t0)/1000).toFixed(2);
  
  console.log("=========================================");
  console.log(`4. MÜZAKERE TAMAMLANDI (${duration}s)!`);
  console.log(`   Plan ID: ${result.planId}`);
  console.log(`   Session ID: ${result.sessionId}`);
  console.log(`   Toplam Tur Sayısı: ${result.turns}`);
  console.log(`   Status: ${result.status}`);
  console.log(`   PROJECT_ID_RUN4=${projectId}`);
  console.log("=========================================");
}

main().catch(err => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});
