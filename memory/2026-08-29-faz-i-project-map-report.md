# Faz I Proje Bilgi Haritası Raporu

Tarih: 2026-08-29

## Durum

Faz I başlatıldı. İlk beş dilim tamamlandı:

1. Proje workspace'inden anlık dosya/controller/fonksiyon haritası çıkaran server projection'ı.
2. Bu haritayı kaynak gösterilebilir kalıcı snapshot olarak saklayan `project_maps` tablosu ve repository yüzeyi.
3. Son proje haritası snapshot'ını görev bağlam paketine ve görev bağlam manifestine bağlayan memory hattı.
4. Panelde gerçek “Proje Haritası” sekmesi: metrikler, route/fonksiyon listesi, arama ve snapshot alma.
5. Production görev brief mühürü öncesinde otomatik proje haritası snapshot'ı.

## Kapsam

- Kaynak dosyalar güvenli workspace sınırı içinde taranır.
- `.git`, `.ww-trash`, `node_modules`, `dist`, `build`, `coverage` atlanır.
- TypeScript AST ile şu bilgiler çıkarılır:
  - Dosya yolu
  - MVVM/katman sınıfı
  - Export edilen semboller
  - Fonksiyon/arrow function/class method adı, dosyası ve satırı
  - Nest `@Controller` + HTTP method decorator route haritası
- Test dosyaları haritadan atılmaz; `test` katmanı olarak etiketlenir. Bu tercih, agent'ın mevcut test yüzeyini görmesini sağlar.
- REST yüzeyi eklendi:
  - `GET /projects/:projectId/files/map`
  - `POST /projects/:projectId/files/map/snapshots`
- Panel servis sözleşmesi eklendi:
  - `fetchProjectMap(projectId)`
  - `createProjectMapSnapshot(projectId)`
- Source manifest sözleşmesine `project_map` kaynak tipi eklendi.
- Bağlam render sözleşmesine `project_maps` bölümü eklendi; prompt içinde “Proje haritası” başlığıyla görünür.
- `project_maps` tablosu ve repository API'leri eklendi:
  - `createProjectMapSnapshot`
  - `getLatestProjectMapSnapshot`
  - `getLatestProjectMapSnapshotAsOf`
  - `getProjectMapSourceRef`
  - `getLatestProjectMapSourceRefAsOf`
- `MemoryService.buildContextPack` son proje haritası snapshot'ını `project_maps` chunk'ı olarak taşır.
- `TaskContextSnapshotBuilder` son proje haritası source ref'ini `sourceVersionManifest` içine `project_map` tipiyle mühürler.
- Canvas içindeki beşinci sekme `Proje Haritası` olarak eklendi; harita canlı endpoint'ten okunur, arama viewmodel'de yapılır, snapshot butonu kalıcı kayıt üretir.
- `TaskBriefService` scheduler bağımlılık yönünü bozmadan opsiyonel `ProjectMapSnapshotterPort` çağırır.
- Production assembly bu port'u `buildProjectMap(input.projectRoot)` + `createProjectMapSnapshot` ile doldurur.
- Otomatik snapshot `baseContextCutoffAt` ile aynı `generatedAt/createdAt` değerini taşır; böylece as-of bağlamda zaman sızıntısı oluşmaz.

## Değişen Dosyalar

- `apps/server/src/project-map.ts`
- `apps/server/src/project-map.test.ts`
- `apps/server/src/artifact-classify.ts`
- `apps/server/src/files.controller.ts`
- `apps/panel/src/services/projects.ts`
- `apps/panel/src/services/projects.test.ts`
- `apps/panel/src/components/CanvasPanel.tsx`
- `apps/panel/src/components/ProjectMapPanel.tsx`
- `apps/panel/src/components/ProjectMapPanel.test.tsx`
- `apps/panel/src/viewmodels/useProjectMapViewModel.ts`
- `packages/shared/src/task-contracts.ts`
- `packages/shared/src/task-contracts.test.ts`
- `packages/db/migrations/0009_project_maps.sql`
- `packages/db/src/repositories/project-maps.ts`
- `packages/db/src/repositories/project-maps.test.ts`
- `packages/db/src/index.ts`
- `packages/db/src/index.test.ts`
- `packages/db/src/migrate.test.ts`
- `apps/server/src/context-pack-render.ts`
- `apps/server/src/context-pack-render.test.ts`
- `packages/memory/src/memory-service.ts`
- `packages/memory/src/summary.integration.test.ts`
- `packages/memory/src/task-context-snapshot-builder.ts`
- `packages/memory/src/task-context-snapshot-builder.test.ts`
- `packages/scheduler/src/task-brief-service.ts`
- `apps/server/src/runtime-composition.ts`
- `apps/server/src/orchestration-assembly.ts`
- `apps/server/package.json`
- `pnpm-lock.yaml`

## Evidence

Komutlar:

```text
pnpm --filter @ww/server exec vitest run src/project-map.test.ts
pnpm --filter @ww/server exec vitest run src/context-pack-render.test.ts src/project-map.test.ts
pnpm --filter @ww/panel exec vitest run src/services/projects.test.ts
pnpm --filter @ww/panel exec vitest run src/components/ProjectMapPanel.test.tsx src/components/CanvasPanel.test.tsx src/services/projects.test.ts
pnpm --filter @ww/panel test
pnpm --filter @ww/panel build
pnpm --filter @ww/shared exec vitest run src/task-contracts.test.ts
pnpm --filter @ww/db exec vitest run src/repositories/project-maps.test.ts src/migrate.test.ts src/index.test.ts
pnpm --filter @ww/memory exec vitest run src/memory-service.test.ts src/summary.integration.test.ts src/task-context-snapshot-builder.test.ts
pnpm --filter @ww/scheduler exec vitest run src/index.test.ts src/repository-boundaries.test.ts
pnpm --filter @ww/shared build
pnpm --filter @ww/db build
pnpm --filter @ww/memory build
pnpm --filter @ww/scheduler build
pnpm --filter @ww/server build
```

Sonuç:

- `project-map.test.ts`: 2/2 geçti
- `context-pack-render.test.ts`: 7/7 geçti
- `projects.test.ts`: 20/20 geçti
- Panel proje haritası/canvas servis dar testleri: 24/24 geçti
- Panel tam test paketi: 72 test dosyası / 384 test geçti
- `@ww/panel build`: geçti
- `task-contracts.test.ts`: 52/52 geçti
- DB project-map/migration/index testleri: 21/21 geçti
- Memory context/snapshot testleri: 19/19 geçti
- Scheduler dar testleri: 5/5 geçti
- `@ww/shared build`: geçti
- `@ww/db build`: geçti
- `@ww/memory build`: geçti
- `@ww/scheduler build`: geçti
- `@ww/server build`: geçti

Canlı projection denemesi:

```text
buildProjectMap('/Users/halituzun/Projects/ww/apps/server/src', { limit: 300 })
```

Özet:

- `fileCount=210`
- `functionCount=443`
- `routeCount=71`
- İlk route örnekleri:
  - `GET /projects/:projectId/agents/:agentId` → `agents.controller.ts:16`
  - `GET /projects/:projectId/artifacts/:artifactId` → `artifacts.controller.ts:17`
  - `GET /projects/:projectId/audit` → `audit.controller.ts:32`

Canlı migration durumu:

```text
runMigrations() -> {"applied":[]}
EXISTS TABLE project_maps -> 1
```

Canlı panel/API durumu:

```text
pnpm --filter @ww/panel dev -> http://localhost:5173/
GET /projects/64fc9149-ec90-45c8-846a-d174c2812cd5/files/map
Chrome headless screenshot -> kanit/40_project_map_panel.png
```

Özet:

- `fileCount=1`
- `functionCount=1`
- `routeCount=0`
- İlk dosya: `ww.gate.check.cjs`
- Panel URL: `http://localhost:5173/?page=canvas&project=64fc9149-ec90-45c8-846a-d174c2812cd5&tab=map`
- Panel kanıtı: `kanit/40_project_map_panel.png`

## Kanıtlanan Faz I Davranışları

- Harita AST üzerinden üretiliyor; dummy liste veya elle yazılmış route yok.
- Test dosyaları görünür kalıyor ve `test` katmanı olarak ayrılıyor.
- Snapshot ClickHouse `project_maps` tablosuna append-only yazılıyor.
- As-of okuma cutoff sonrasındaki haritayı bağlama sızdırmıyor.
- Görev bağlam manifestinde `project_map` source ref hash'li olarak duruyor.
- Prompt render hattı `project_maps` chunk'ını “Proje haritası” bölümü altında gösteriyor.
- Panelde route ve fonksiyon araması dosya listesini daraltıyor; `Snapshot Al` kalıcı snapshot endpoint'ine bağlı.
- Görev brief mühürü production akışında context snapshot'tan önce proje haritası snapshot'ı alıyor.
- Canlı panelde `Proje Haritası` sekmesi açıkken yeşil `Canlı · 30 olay`, metrikler ve dosya/fonksiyon kartı görünüyor.

## Kalan İş

- Faz J öncesinde: harita snapshot'ının yeni görev emri ayrıştırma akışında doğru departman/dosya önerilerine girdiğini uçtan uca kanıtlamak.

## Status

KAPANDI
