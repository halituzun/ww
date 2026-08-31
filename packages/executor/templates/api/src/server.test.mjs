import test from 'node:test';
test('api starter has a health server', async () => { const { server } = await import('./server.mjs'); if (!server) throw new Error('server yok'); server.close(); });
