import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const discarded = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64url').toString('utf8'));
const maxBytes = Number(process.argv[3]);
if (!Array.isArray(discarded) || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) process.exit(125);

const root = '/workspace';
const entries = [];
let totalBytes = 0;

function discardedPath(relativePath) {
  return discarded.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`));
}

function forbiddenName(name) {
  const lower = name.toLocaleLowerCase('en-US');
  return lower === '.git' || lower === 'secrets' || lower === '.env' || lower.startsWith('.env.');
}

async function visit(directory, relativeDirectory) {
  const names = await readdir(directory);
  names.sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    const relativePath = relativeDirectory === '' ? name : `${relativeDirectory}/${name}`;
    if (discardedPath(relativePath)) continue;
    const absolute = path.join(directory, name);
    const info = await lstat(absolute);
    if (forbiddenName(name) || info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
      entries.push({ path: relativePath, type: 'forbidden' });
      continue;
    }
    if (info.isDirectory()) {
      await visit(absolute, relativePath);
      continue;
    }
    const content = await readFile(absolute);
    totalBytes += content.byteLength;
    if (totalBytes > maxBytes) {
      process.stdout.write(JSON.stringify({ version: 1, error: 'OUTPUT_LIMIT', totalBytes }));
      process.exit(42);
    }
    entries.push({
      path: relativePath,
      type: 'file',
      bytes: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
      content: content.toString('base64'),
    });
  }
}

await visit(root, '');
process.stdout.write(JSON.stringify({ version: 1, totalBytes, entries }));
