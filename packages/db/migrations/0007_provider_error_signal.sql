-- docs/04 Sağlık Kontrolü, pasif sinyal: "mv_provider_errors — son 5 dk hata
-- oranı > %50 → degraded".
--
-- İki kusur ölçüldü (canlı ClickHouse, 2026-08-18):
--
-- 1) `fallback_used` HATA sayılıyordu. Oysa o BAŞARILI bir çağrıdır: yedek
--    sağlayıcı isteği karşılamıştır. Canlı veride 6 çağrı, 12.432 token ve
--    $0.0064 maliyet taşıyor — yani faturalanmış işler. Başarıyla devreye
--    giren yedeği cezalandırmak, fallback'i tam da işe yaradığı anda
--    "bozuk" göstermek demekti.
--
-- 2) Sağlık ping'leri sayılıyordu. docs/04 iki BAĞIMSIZ sinyal tanımlar:
--    aktif ping (art arda hata → down) ve pasif hata oranı (gerçek trafik →
--    degraded). Ping'leri pasif sinyale katmak ikisini tek sinyale indirger:
--    gerçek trafiği olmayan bir sağlayıcı, yalnız ping'leri yüzünden %100
--    hata oranı gösteriyordu (mock: 1366/1366, deepseek: %30,5).
--
-- Görünüm yeniden kurulur; api_usage bozulmadan durduğu için kaybedilen tek
-- şey yanlış hesaplanmış özettir.
DROP VIEW IF EXISTS mv_provider_errors;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_provider_errors
ENGINE = SummingMergeTree ORDER BY (provider_id, minute)
AS SELECT
  provider_id,
  toStartOfMinute(created_at) AS minute,
  countIf(status IN ('error', 'timeout', 'rate_limited')) AS errors,
  count() AS total
FROM api_usage
WHERE purpose != 'health_check'
GROUP BY provider_id, minute
