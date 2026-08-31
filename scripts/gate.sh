#!/usr/bin/env bash
# Tam kapı. Sıfır çıkış kodu = commit/push GÜVENLİ.
#
# NEDEN VAR: kapı adımları ile commit/push ayrı ayrı çalıştırıldığında, kapı
# düşse bile push koşuyordu — bu depoda bir kez gerçekten oldu. Tek komut ve
# tek çıkış kodu, "kırık kod push etme" kuralını niyete değil kabuğa bağlar.
#
# SIRA NEDEN BÖYLE: öz-denetim ve wiring-check saniyeler sürer, test seti
# dakikalar. Eskiden ucuz denetimler EN SONDAYDI; operatör hatayı görmek için
# tüm test bedelini ödüyordu ve pratikte kapıyı atlıyordu (2026-08-31
# ölçümü: her iki ucuz denetim de HEAD'de kırmızıydı). İkisi de derlenmiş
# dist'e ihtiyaç duyduğu için build'den hemen sonraya alındılar.
#
# Kullanım:  ./scripts/gate.sh && git commit -F mesaj && git push
set -euo pipefail

cd "$(dirname "$0")/.."

TEST_LOG="$(mktemp -t ww-gate-test)"
trap 'rm -f "$TEST_LOG"' EXIT

echo "[kapı] sızmış test verisi temizleniyor"
# Temizlik hatası YUTULMAZ: ClickHouse kapalıysa bunu birkaç dakika sonra
# entegrasyon testlerinin çökmesinden değil, buradan öğrenmek gerekir.
if ! pnpm db:clean-tests >/dev/null 2>&1; then
  echo "[kapı] UYARI: test verisi temizlenemedi (ClickHouse/Redis kapalı olabilir)"
fi

echo "[kapı] build"
pnpm build >/dev/null

echo "[kapı] öz-denetim (docs/09)"
# ww kendi standardını KENDİNE de uygular. Denetçi üretilen projeleri
# denetliyordu ama ww'nin kendi paneline yalnız biri ELLE koşturunca
# bakılıyordu; yani sonraki oturumun ekleyeceği bir ihlali hiçbir şey
# yakalamazdı.
node scripts/audit-self.mjs

echo "[kapı] wiring-check"
node packages/wiring-check/dist/cli.js >/dev/null

echo "[kapı] durum kaydı (docs/DURUM.md)"
# Durum üç ayrı dosyada elle tutuluyordu ve üçü de bayatladı. Sayılar artık
# üretiliyor.
#
# YERELDE ÜRETİR, DÜŞÜRMEZ: ilk sürüm `--check` ile kapıyı düşürüyordu ve tek
# bir test eklemek bile kapıyı kırmızıya çeviriyordu — bu, kapıyı atlamayı
# öğreten türden bir gürültüdür. Burada dosya güncellenir ve değişiklik
# operatörün commit'ine katılır; bayat bir DURUM.md'nin PR'a girmesini
# CI'daki `durum.mjs --check` adımı engeller.
node scripts/durum.mjs

echo "[kapı] lint"
pnpm lint >/dev/null

echo "[kapı] test (entegrasyon dahil)"
WW_REQUIRE_INTEGRATION=1 pnpm test >"$TEST_LOG" 2>&1 || {
  echo "[kapı] TESTLER DÜŞTÜ:"
  grep -E "✕|FAIL" "$TEST_LOG" | head -20
  echo "[kapı] tam günlük: $TEST_LOG"
  trap - EXIT
  exit 1
}

echo "[kapı] TÜM KAPILAR YEŞİL"
