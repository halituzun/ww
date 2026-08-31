// Çalışma ağacını son commit'e döndürme (docs/01 Çökme Kurtarma madde 3;
// docs/05 "Ret/iptal/kurtarma → git checkout . && git clean -fd").
//
// NEDEN VAR: HİÇBİR üretim kodu working tree'yi temizlemiyordu. Çökme
// sonrası yarım yazılmış dosyalar diskte kalıyor ve sonraki deneme KİRLİ
// ağaçtan başlıyordu: worker yarım dosyayı okuyabiliyor, kapı bayat içerikle
// koşuyor ve commit önceki başarısız denemeden artık taşıyabiliyordu.
import type { ExecutorHostCommandPort } from './ports.js';
import { WorkspacePaths } from './workspace-paths.js';

/**
 * Sıra ÖNEMLİ: önce izlenen dosyalar geri alınır, sonra izlenmeyenler
 * silinir. Tersi sırada, geri alınan dosya yeniden "izlenmeyen" görünüp
 * silinebilirdi.
 *
 * `-x` KULLANILMAZ: yok sayılan dosyaları da silmek `node_modules` ve yerel
 * yapılandırmayı yok eder — kurtarma, kurtardığından fazlasını bozar.
 *
 * ÇÖP KUTUSU korunur: `delete_file` silinen dosyayı `.ww-trash/` altına taşır
 * (geri alınabilsin diye); onu da silmek kullanıcının geri alabileceği tek
 * kopyayı yok ederdi.
 */
export const WORKSPACE_RESET_COMMANDS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(['checkout', '--', '.']),
  Object.freeze(['clean', '-fd', '-e', `${WorkspacePaths.TRASH_DIR}/`]),
]);

/**
 * Ağacı son commit'e döndürür.
 *
 * GitWorkspace'in METODU DEĞİL: o sınıf kapı çalıştırıcı ve erişim portu
 * ister; sıfırlama yalnız komut çalıştırıcıya ihtiyaç duyar. Ağır bir sınıfı
 * yalnızca iki git komutu için kurmak, açılış yolunu gereksiz bağımlılıkla
 * yükler.
 */
export async function resetWorkingTree(
  runner: Pick<ExecutorHostCommandPort, 'run'>,
  projectKey: string,
  workspaceRoot: string,
): Promise<void> {
  for (const args of WORKSPACE_RESET_COMMANDS) {
    const result = await runner.run({
      projectKey, command: 'git', args: [...args], cwd: workspaceRoot, timeoutMs: 120_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args[0]} basarisiz (${result.exitCode}): ${result.stderr.slice(0, 200)}`);
    }
  }
}
