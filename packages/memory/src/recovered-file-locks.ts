// Ölü görevin dosya kilitlerinin bırakılması (docs/07 → kurtarma: "görev
// queued'a döner, agent stopped, KİLİTLER BIRAKILIR").
//
// NEDEN VAR: kurtarmanın hiç dosya kilidi işlemi yoktu. Ölü görevin kilitleri
// TTL dolana dek (~8,5 dakika) duruyordu; kurtarma görevi hemen kuyruğa aldığı
// için yeni deneme kendi dosyalarını KİLİTLİ buluyor ve o pencere boyunca
// çalışamıyordu.
//
// Kilit sahibi `assignmentAttemptId`'dir. Bırakma çağrısı sahiplik kontrollüdür:
// başka bir sahibin kilidi verilse bile dokunulmaz. Bu yüzden ölü denemenin
// kimliğiyle çağırmak güvenlidir — canlı bir denemenin kilidini çalamaz.
import { createHash } from 'node:crypto';

export interface FileLockRelease {
  readonly fileHash: string;
  readonly owner: string;
}

/** Kilit anahtarı dosya yolunun SHA-1'idir (executor ile aynı türetme). */
export function fileHashOf(relativePath: string): string {
  return createHash('sha1').update(relativePath).digest('hex');
}

/**
 * Bırakılacak kilitler. Sahipsiz (NIL) denemede hiçbir şey bırakılmaz:
 * sahibi bilinmeyen kilidi bırakmak, çalışan başka bir işi soymak olurdu.
 */
export function plannedLockReleases(
  targetFiles: readonly string[],
  assignmentAttemptId: string,
  nilAttemptId: string,
): readonly FileLockRelease[] {
  if (assignmentAttemptId === '' || assignmentAttemptId === nilAttemptId) return [];
  const unique = [...new Set(targetFiles.filter((path) => path.trim() !== ''))].sort();
  return Object.freeze(unique.map((path) => Object.freeze({
    fileHash: fileHashOf(path),
    owner: assignmentAttemptId,
  })));
}
