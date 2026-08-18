#!/usr/bin/env bash
# Tam kapı. Sıfır çıkış kodu = commit/push GÜVENLİ.
#
# NEDEN VAR: kapı adımları ile commit/push ayrı ayrı çalıştırıldığında, kapı
# düşse bile push koşuyordu — bu depoda bir kez gerçekten oldu. Tek komut ve
# tek çıkış kodu, "kırık kod push etme" kuralını niyete değil kabuğa bağlar.
#
# Kullanım:  ./scripts/gate.sh && git commit -F mesaj && git push
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[kapı] sızmış test verisi temizleniyor"
pnpm db:clean-tests >/dev/null 2>&1 || true

echo "[kapı] build"
pnpm build >/dev/null

echo "[kapı] test (entegrasyon dahil)"
WW_REQUIRE_INTEGRATION=1 pnpm test >/tmp/ww-gate-test.log 2>&1 || {
  echo "[kapı] TESTLER DÜŞTÜ:"
  grep -E "✕|FAIL" /tmp/ww-gate-test.log | head -10
  exit 1
}

echo "[kapı] lint"
pnpm lint >/dev/null

echo "[kapı] wiring-check"
node packages/wiring-check/dist/cli.js >/dev/null

# ww kendi standardını KENDİNE de uygular (docs/09). Denetçi üretilen
# projeleri denetliyordu ama ww'nin kendi paneline yalnız biri ELLE
# koşturunca bakılıyordu; yani sonraki oturumun ekleyeceği bir ihlali hiçbir
# şey yakalamazdı.
echo "[kapı] öz-denetim (docs/09)"
node scripts/audit-self.mjs

echo "[kapı] TÜM KAPILAR YEŞİL"
