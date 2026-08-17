// Proje workspace iskeletini diske yazar.
//
// Ayrı dosya: `defaultGateConfig` saf ve test edilebilir kalsın; disk yazımı
// burada. Var olan yapılandırmanın ÜZERİNE YAZILMAZ — kullanıcı kapıyı
// düzenlemişse onu ezmek sessiz bir gerileme olur.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultGateConfig, starterFiles } from './project-scaffold.js';

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

  // Kapı girdileri var olmayan dosyaya işaret ederse iş kabul edilemez.
  for (const [name, content] of starterFiles(projectType, projectName)) {
    await writeFile(path.join(workspaceRoot, name), content, { encoding: 'utf8', flag: 'wx' })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
  }
}
