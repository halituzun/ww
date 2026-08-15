import { createServer } from 'node:http';
export const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true })); });
if (import.meta.url === `file://${process.argv[1]}`) server.listen(process.env.PORT ?? 3000);
