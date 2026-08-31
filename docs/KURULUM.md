# ww yerel kurulum

Sıfırdan çalışır duruma gelmek için gereken adımların tamamı. Aşağıdaki akış
2026-08-16'da baştan sona koşulup doğrulandı.

Gereksinimler: Node.js 22+, pnpm 11.1.3, Docker Desktop (veya Docker Engine + Compose).

## 1. Bağımlılıklar ve servisler

```bash
pnpm install
docker compose up -d
```

Servisler bilinçli olarak standart dışı portlarda: ClickHouse `8124`, Redis `6380`
(makinede başka projelerin `8123`/`6379` container'ları olabilir). `WW_CH_URL` ve
`WW_REDIS_URL` ile değiştirilebilir.

## 2. Kapıyı doğrula

```bash
pnpm build
pnpm lint
WW_REQUIRE_INTEGRATION=1 pnpm test          # 2047 test — skip'i hataya çevirir
pnpm --filter @ww/executor runtime:build    # canlı sandbox imajı
pnpm --filter @ww/executor test:live        # +4 canlı Docker sandbox testi
```

Son iki komut zorunludur: executor'ın 4 canlı sandbox testi `WW_DOCKER_LIVE=1`
istediğinden varsayılan `pnpm test` koşusunda **sessizce atlanır**. Depo kuralı
gereği atlanan test kapı sayılmaz.

## 3. Yerel sırlar

Server ile panel aynı oturum tokenını paylaşmalıdır; panel bunu build zamanında
`VITE_SESSION_TOKEN`'dan okur, server ise `WW_LOCAL_SESSION_TOKEN`'dan.

```bash
TOKEN=$(openssl rand -hex 24)
MASTER=$(openssl rand -hex 32)

cat > .env <<EOF
WW_LOCAL_SESSION_TOKEN=$TOKEN
WW_MASTER_KEY=$MASTER
WW_KEYSTORE_FILE=$(pwd)/.ww/keys.json
EOF

cat > apps/panel/.env.local <<EOF
VITE_API_PROXY_TARGET=http://localhost:4000
VITE_SESSION_TOKEN=$TOKEN
EOF

chmod 600 .env apps/panel/.env.local
```

`.env`, `.env.*` ve `.ww/` gitignore kapsamındadır — anahtar dosyası asla
commit'lenmemelidir. `WW_MASTER_KEY` verilmezse keystore macOS Keychain'e düşer.

## 4. Çalıştır

```bash
set -a && . ./.env && set +a
pnpm --filter @ww/server build && node apps/server/dist/main.js   # http://localhost:4000
pnpm --filter @ww/panel dev                                       # http://localhost:5173
```

Server açılışta migration'ları uygular ve bounded proje recovery çalıştırır.
Sağlık kontrolü:

```bash
curl -s http://localhost:4000/health     # {"ok":true,"clickhouse":true,"redis":true}
```

## 5. Gerçek sağlayıcı anahtarı

Sağlayıcı kaydını oluştur (anahtarsız), sonra anahtarı **panelden** gir:

```bash
curl -X PATCH http://localhost:4000/providers/deepseek \
  -H "content-type: application/json" \
  -H "authorization: Bearer $WW_LOCAL_SESSION_TOKEN" \
  -d '{"displayName":"DeepSeek","baseUrl":"https://api.deepseek.com",
       "models":["deepseek-chat","deepseek-reasoner"],
       "enabled":true,"isDefault":true,"fallbackOrder":0}'
```

Panelde `http://localhost:5173` → **API sağlayıcıları** → ilgili kartın anahtar
alanı. Anahtar tarayıcıdan server'a gider, AES-256-GCM ile şifrelenip keystore
dosyasına yazılır; ClickHouse'a veya loglara düşmez, API yanıtlarında yalnız
`sk-…1234` maskesi döner. Anahtarı kabuk geçmişine veya bir sohbete yapıştırma.

Desteklenen sağlayıcılar: OpenAI, Anthropic, DeepSeek, Google Gemini (`gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-1.5-flash`, `gemini-1.5-pro`), Mistral (`mistral-large-latest`, `mistral-medium-latest`, vb.) ve yerel Ollama.

Konsey (Faz 4) en az üç farklı sağlayıcı ister; tek anahtar Faz 3 için yeterlidir.

## Küçük uçtan uca denemeler

- Web: `packages/executor/templates/web` ile panelde proje oluşturup görev
  hedeflerini izleyin.
- API: `packages/executor/templates/api` minimal health endpoint'i içerir.
- Mobil: `packages/executor/templates/mobile` Flutter başlangıç sözleşmesini ve
  test kapısını içerir; gerçek AVD bağlantısı injected adapter üzerinden yapılır.

Üretim executor komutları Docker sandbox içinde çalışır; host çalışma alanı
container'a canlı olarak bağlanmaz.
