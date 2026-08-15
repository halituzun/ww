import { describe, expect, it } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('packaged starter templates', () => {
  it('contains web, api and mobile gates with no host-only assumptions', async () => {
    const root = resolve(process.cwd(), 'templates');
    for (const path of ['web/ww.gate.json', 'api/ww.gate.json', 'mobile/ww.gate.json']) {
      await expect(access(resolve(root, path))).resolves.toBeUndefined();
      const content = await readFile(resolve(root, path), 'utf8');
      expect(JSON.parse(content).version).toBe(1);
    }
  });
});
