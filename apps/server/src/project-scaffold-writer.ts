// Proje workspace iskeletini diske yazar.
//
// Ayrı dosya: `defaultGateConfig` saf ve test edilebilir kalsın; disk yazımı
// burada. Var olan yapılandırmanın ÜZERİNE YAZILMAZ — kullanıcı kapıyı
// düzenlemişse onu ezmek sessiz bir gerileme olur.
import { execFile } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { defaultGateConfig, starterFiles } from './project-scaffold.js';

const run = promisify(execFile);

export async function writeProjectScaffold(
  workspaceRoot: string,
  projectType: string,
  projectName: string,
): Promise<void> {
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
  const gatePath = path.join(workspaceRoot, 'ww.gate.json');
  await writeFile(
    gatePath,
    `${JSON.stringify(defaultGateConfig(projectType), null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  ).catch((error: NodeJS.ErrnoException) => {
    // Zaten varsa dokunma; başka hata yutulmaz.
    if (error.code !== 'EEXIST') throw error;
  });

  // docs/00: her proje KENDİ git deposudur. Depo yoksa commit adımı
  // "commit edilecek değişiklik yok" der (üst depo workspace'i yok sayar) ve
  // iş kapıyı geçse bile tarihe hiç yazılamaz.
  try {
    await stat(path.join(workspaceRoot, '.git'));
  } catch {
    await run('git', ['init', '--quiet'], { cwd: workspaceRoot });
    await run('git', ['config', 'user.email', 'ww@local'], { cwd: workspaceRoot });
    await run('git', ['config', 'user.name', 'ww'], { cwd: workspaceRoot });
  }

  // Kapı girdileri var olmayan dosyaya işaret ederse iş kabul edilemez.
  for (const [name, content] of starterFiles(projectType, projectName)) {
    await writeFile(path.join(workspaceRoot, name), content, { encoding: 'utf8', flag: 'wx' })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
  }
}
