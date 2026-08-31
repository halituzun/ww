import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

const [command, ...args] = process.argv.slice(2);
if (command === undefined || command.length === 0) process.exit(125);

const child = spawn(command, args, {
  detached: true,
  env: process.env,
  shell: false,
  stdio: 'inherit',
});

function killGroup(signal) {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); } catch { /* already exited */ }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => killGroup(signal));
}

const outcome = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code, signal) => resolve({ code, signal }));
});

killGroup('SIGTERM');
await new Promise((resolve) => setTimeout(resolve, 25));
killGroup('SIGKILL');

// Detached grandchildren can create a new process group. Sweep every process
// owned by the untrusted uid before the wrapper returns and snapshot begins.
for (const entry of await readdir('/proc')) {
  if (!/^\d+$/.test(entry)) continue;
  const pid = Number(entry);
  if (pid === 1 || pid === process.pid) continue;
  try {
    const status = await readFile(`/proc/${entry}/status`, 'utf8');
    const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
    if (uid === process.getuid()) process.kill(pid, 'SIGKILL');
  } catch { /* raced with process exit */ }
}

if (outcome.signal !== null) process.exit(128);
process.exit(outcome.code ?? 125);
