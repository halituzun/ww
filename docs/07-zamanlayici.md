# 07 — Zamanlayıcı

> Kuyruk tasarımı, eşzamanlılık ve rate limitleri, dosya kilitleri, frenler
> (ping-pong, bütçe, kaçak döngü), zaman aşımı ve kurtarma senaryoları.
> İlgili: [Mimari](01-mimari.md) · [Agent Sistemi](03-agent-sistemi.md) · [Şema](02-clickhouse-semasi.md)

## İçindekiler

1. [Kuyruk Tasarımı](#kuyruk-tasarımı)
2. [Atama Algoritması](#atama-algoritması)
3. [Eşzamanlılık ve Rate Limitleri](#eşzamanlılık-ve-rate-limitleri)
4. [Dosya Kilitleri](#dosya-kilitleri)
5. [Frenler](#frenler)
6. [Zaman Aşımı ve Heartbeat](#zaman-aşımı-ve-heartbeat)
7. [Kurtarma Senaryoları](#kurtarma-senaryoları)

---

## Kuyruk Tasarımı

- Proje başına Redis Stream: `ww:queue:<project_id>`; tüketici grubu `scheduler`.
- Kuyruğa giren mesaj yalnızca `{task_id}` taşır — gerçek veri her zaman `tasks`
  tablosundadır (Redis kaybı = veri kaybı değil, [Mimari](01-mimari.md#clickhouse--redis-görev-ayrımı)).
- Görev `queued` yazıldığı anda stream'e de eklenir. Öncelik: stream FIFO'dur;
  zamanlayıcı tüketirken `priority` alanına göre küçük bir yeniden sıralama
  tamponu (son 20 mesaj) kullanır — katı öncelik kuyruğu v1'de gereksiz.
- Claim: tüketici `ww:task:<id>:claim` kilidini (SETNX, TTL 10 dk) alamazsa mesajı
  bırakır — çift işleme koruması.

## Atama Algoritması

Görev kuyruktan çekildiğinde:

```
1. Bağımlılık kontrolü      → depends_on içinde done olmayan varsa geri bırak (erteleme: 30 sn)
2. Dosya çakışması kontrolü → target_files kilitli mi? kilitliyse ertele
3. Fren kontrolleri         → bütçe/kontör/limitler (aşağıda); takılırsa duraklat+tırmandır
4. Worker seç               → grubu uyan idle agent; yoksa klonla (limit dahilinde);
                              klon da açılamıyorsa geri bırak
5. Verifier seç             → worker'dan farklı sağlayıcı tercihli idle/klon
6. Kilitleri al             → target_files için dosya kilitleri
7. tasks → assigned         → agents.status=busy; worker döngüsünü başlat
```

## Eşzamanlılık ve Rate Limitleri

| Limit | Varsayılan | Nerede |
|---|---|---|
| Global paralel agent | 8 | `settings.max_parallel_agents` (global ayar) |
| Proje başına paralel agent | 5 | proje `settings` |
| Agent başına klon | 5 | `settings.max_clones_per_agent` |
| Sağlayıcı başına istek/dk | sağlayıcıya göre (`api_providers.settings`) | provider router token-bucket |
| Proje başına eşzamanlı komut | 4 | executor |
| Delegasyon derinliği | 3 | `settings.max_delegation_depth` |

Rate limit aşımında router bekletir (kuyruklu token-bucket); 429 dönerse
üstel geri çekilme + 2 denemeden sonra fallback ([04](04-model-katmani.md#fallback)).

## Dosya Kilitleri

- Anahtar: `ww:lock:file:<project_id>:<sha1(path)>`, değer `task_id`, TTL 15 dk
  (heartbeat'le yenilenir).
- Alım atama sırasında topluca yapılır (`target_files`); hepsi alınamazsa hiçbiri
  alınmaz (deadlock önleme — all-or-nothing).
- Worker çalışırken `write_file/edit_file` yalnız kilitli yollara izin verir;
  öngörülmemiş dosya ihtiyacında araç `LOCKED`/`NOT_DECLARED` döner; worker
  `create_subtask` veya kilit genişletme isteğiyle ilerler (zamanlayıcı boşsa verir).
- Görev kapanışında (done/failed/cancelled/escalated) kilitler bırakılır;
  `events`'e `lock_acquired`/`lock_released` yazılır.

## Frenler

| Fren | Tetik | Davranış |
|---|---|---|
| **Ping-pong freni** | worker↔verifier ret döngüsü `attempt ≥ max_attempts` (3) | Görev `escalated`; zincir: group_lead → professor → PM → kullanıcı ([03](03-agent-sistemi.md#tırmandırma-zinciri)) |
| **Görev token tavanı** | `tokens_spent ≥ token_budget` | Görev duraklar → tırmandırma; PM bütçe artırabilir veya görevi böler |
| **Proje kontör tavanı** | `mv_usage_daily` toplamı ≥ `budget_usd_limit` | Proje `paused`; panel bildirimi; kullanıcı kararı beklenir |
| **Kaçak döngü** | Son 3 denemenin hata çıktıları ≥ %90 benzer (normalize edilmiş metin benzerliği) | Deneme hakkı bitmemişse bile erken tırmandırma — aynı duvara tekrar koşturmayı keser |
| **Kuyruk taşması** | `queued` görev sayısı > 200 (proje) | Yeni delegasyon reddedilir, PM'e uyarı — plan hatası işareti |

Her fren tetiklenişi `events`'e (`escalation`) + panele bildirim olarak düşer.

## Zaman Aşımı ve Heartbeat

- Agent döngüsü her tool turunda `ww:hb:<agent_id>` anahtarını yeniler (TTL 30 sn).
- Süpürücü (10 sn'de bir): `busy` agent'lardan heartbeat'i düşenleri bulur →
  görev `queued`'a döner (`attempt` korunur), agent `stopped`, kilitler bırakılır.
- Görev duvar-saati tavanı: `settings.task_wall_clock_min` (varsayılan 60 dk) —
  aşan görev kesilir ve tırmandırılır (sonsuz sürünme önleme).
- API çağrısı zaman aşımı: 120 sn (router).

## Kurtarma Senaryoları

Mimari dokümandaki tabloyu ([01 — Çökme Kurtarma](01-mimari.md#çökme-kurtarma))
zamanlayıcı açısından tamamlar:

- **Açılış sırası**: migration kontrolü → `RecoveryService` → süpürücü → tüketiciler.
- **RecoveryService adımları**:
  1. `tasks` son-durumlarını tara; `assigned/working/verifying/testing` olanları
     heartbeat'siz ise `queued`'a düşür.
  2. `agents` son-durumlarını tara; `busy` olanları `idle`'a çek (heartbeat yoksa).
  3. Redis stream'leri `queued` görevlerle yeniden doldur (claim'i boş olanlar).
  4. Working tree'leri temizle (`git checkout . && git clean -fd`) — yarım iş kuralı.
  5. `events`'e `recovery_completed` kaydı.
- **Deterministik test**: mock provider ile "çalışma ortasında server'ı öldür →
  yeniden başlat → proje kaldığı yerden biter" senaryosu entegrasyon test setindedir
  ([11 — Faz 2](11-yol-haritasi.md#faz-2)).
