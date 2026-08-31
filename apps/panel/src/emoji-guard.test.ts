import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Unicode emoji aralıkları (panelde YASAKTIR)
const EMOJI_REGEX = /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

function getSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') {
        files.push(...getSourceFiles(fullPath));
      }
    } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
      if (!entry.name.endsWith('.test.ts') && !entry.name.endsWith('.test.tsx')) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

describe('Panel Emoji Guard (Yasaklı Emoji Taraması)', () => {
  it('kaynak kodlarında hiçbir emoji karakteri barındırmaz', () => {
    const srcDir = path.resolve(__dirname);
    const files = getSourceFiles(srcDir);
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (EMOJI_REGEX.test(line)) {
          violations.push({
            file: path.relative(srcDir, file),
            line: idx + 1,
            text: line.trim(),
          });
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
