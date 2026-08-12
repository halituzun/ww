# ww — Uygulama Yazan Uygulama Platformu

**ww**, birden çok LLM API'sini (OpenAI, Anthropic/Claude, DeepSeek, …) orkestre ederek
kendi kendine yazılım projeleri üreten, **ClickHouse merkezli** çok-agent'lı bir platformdur.

Temel ilke: **Her şey veritabanı üzerinden yürür.** Planlar, tartışmalar, görevler,
üretilen her artefakt, her tool çağrısı ve her karar ClickHouse'a işlenir; agent'lar
işlerini oradan alır, bağlamlarını oradan kurar, sonuçlarını oraya yazar.
Hiçbir bağlam asla unutulmaz.

## Belgeler

Tüm mimari ve tasarım dokümanları `docs/` altındadır:

| Doküman | İçerik |
|---|---|
| [00 — Genel Bakış](docs/00-genel-bakis.md) | Vizyon, sözlük, üst düzey mimari, karar kaydı |
| [01 — Mimari](docs/01-mimari.md) | Monorepo, servisler, Docker topolojisi, veri akışı, kurtarma |
| [02 — ClickHouse Şeması](docs/02-clickhouse-semasi.md) | Tüm tablolar, örnek sorgular, migration |
| [03 — Agent Sistemi](docs/03-agent-sistemi.md) | Roller, gruplar, konsey, worker+verifier, klonlama, protokol |
| [04 — Model Katmanı](docs/04-model-katmani.md) | Provider soyutlaması, fallback, kontör, anahtar güvenliği |
| [05 — Executor](docs/05-executor.md) | Tool-use araçları, sandbox, git, çalıştırma/test kapısı |
| [06 — Hafıza ve Bağlam](docs/06-hafiza-ve-baglam.md) | Hafıza piramidi, Context Builder, "nasıl yaptın?" akışı |
| [07 — Zamanlayıcı](docs/07-zamanlayici.md) | Kuyruk, eşzamanlılık, kilitler, frenler, tırmandırma |
| [08 — Panel](docs/08-panel.md) | Web panel ekranları, canlı tuval, fihrist, WebSocket sözleşmesi |
| [09 — Kod Standartları](docs/09-kod-standartlari.md) | MVVM şablonları, starter template'ler, denetçi listeleri |
| [10 — Test Ortamları](docs/10-test-ortamlari.md) | Web önizleme, Android emülatör, API konsolu |
| [11 — Yol Haritası](docs/11-yol-haritasi.md) | Fazlar, "bitti" tanımları, doğrulama senaryoları |

## Hızlı Özet

- **Stack**: TypeScript monorepo (pnpm + Turborepo) — NestJS server + React panel
- **Veri**: ClickHouse (tek gerçek kaynak) + Redis (kuyruk/kilit/canlı durum tamponu)
- **Çalışma ortamı**: Lokal, tek kullanıcı, Docker Compose
- **Agent modeli**: Her iş için *yapan* (worker) + *denetleyen* (verifier) çifti; en üstte
  PM agent; plan 3-4 modelin konsey tartışmasıyla oluşur; meşgul agent kendini klonlar
- **Üretilen projeler**: Web / Mobil (Flutter) / Backend API — hepsi MVVM şablonlu,
  her biri otomatik git deposu
