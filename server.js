// kons — yapay zekâ ajanları için sohbet merkezi.
//   Tarayıcı paneli : http://127.0.0.1:4700
//   Ajanlar (MCP)   : http://127.0.0.1:4700/mcp
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Hub, HubError } from './lib/hub.js';
import { handleMcp } from './lib/mcp.js';
import { handleAgentApi } from './lib/rest.js';
import { Runner } from './lib/runner.js';
import { buildState, olderMessages, exportRoom, runAction } from './lib/admin.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4700;
const HOST = process.env.HOST || '127.0.0.1';
const DATA = process.env.KONS_DATA || path.join(ROOT, 'data');
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const hub = new Hub(DATA);
const runner = new Runner(hub, { root: ROOT, dataDir: DATA, url: `http://127.0.0.1:${PORT}` });

// --- tarayıcıya canlı güncelleme (SSE)
const viewers = new Set();
let pending = false;
const broadcast = () => {
  if (pending) return;
  pending = true;
  setTimeout(() => { pending = false; for (const r of viewers) r.write('data: r\n\n'); }, 120);
};
hub.on('refresh', broadcast);
hub.on('message', broadcast);
setInterval(() => { for (const r of viewers) r.write(': ping\n\n'); }, 25000).unref();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const json = (res, code, obj) => res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(obj));

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 4e6) throw new HubError('İstek çok büyük.'); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new HubError('Geçersiz JSON.'); }
}

const server = http.createServer(async (req, res) => {
  try {
    // Yalnızca yerel kullanım: başka sitelerin bu sunucuya istek atmasını engelle.
    if (HOST === '127.0.0.1') {
      const origin = req.headers.origin;
      if (!LOCAL.test(req.headers.host || '') || (origin && !LOCAL.test(origin.replace(/^https?:\/\//, '')))) return json(res, 403, { error: 'Yalnızca yerel erişim.' });
    }
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (p === '/mcp') return await handleMcp(hub, req, res, url, req.method === 'POST' ? await readBody(req) : null);

    if (p.startsWith('/api/agent/')) return await handleAgentApi(hub, req, res, p, req.method === 'POST' ? await readBody(req) : {});
    // Ajanların talimatı ve istemciyi doğrudan sunucudan alabilmesi için
    if (p === '/AGENTS.md') return res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' }).end(await readFile(path.join(ROOT, 'AGENTS.md')));
    if (p === '/kons.mjs') return res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(await readFile(path.join(ROOT, 'client', 'kons.mjs')));

    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('data: r\n\n');
      viewers.add(res);
      req.on('close', () => viewers.delete(res));
      return;
    }
    if (p === '/api/state') return json(res, 200, { ...buildState(hub, url.searchParams.get('room')), bridge: path.join(ROOT, 'bridge.mjs'), root: ROOT });
    if (p === '/api/messages') return json(res, 200, olderMessages(hub, url.searchParams.get('room'), url.searchParams.get('before')));
    if (p === '/api/run') return json(res, 200, runner.view(Number(url.searchParams.get('id'))) || {});
    if (p === '/api/log') return json(res, 200, hub.all('SELECT * FROM events ORDER BY id DESC LIMIT 200'));
    if (p === '/api/export') {
      const fmt = url.searchParams.get('format') === 'json' ? 'json' : 'md';
      const room = url.searchParams.get('room');
      res.writeHead(200, { 'Content-Type': fmt === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="kons-${room}.${fmt}"` });
      return res.end(exportRoom(hub, room, fmt));
    }
    if (p === '/api/action' && req.method === 'POST') {
      if (!String(req.headers['content-type'] || '').includes('application/json')) return json(res, 415, { error: 'application/json gerekli.' });
      return json(res, 200, { ok: true, ...runAction(hub, await readBody(req), runner) });
    }

    if (req.method === 'GET') {
      const file = p === '/' ? 'index.html' : p.slice(1);
      const full = path.join(ROOT, 'public', file);
      if (full.startsWith(path.join(ROOT, 'public')) && TYPES[path.extname(full)]) {
        try { return res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)], 'Cache-Control': 'no-cache' }).end(await readFile(full)); } catch { /* 404 */ }
      }
    }
    json(res, 404, { error: 'Bulunamadı.' });
  } catch (e) {
    if (e instanceof HubError) return json(res, 400, { error: e.message });
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: String(e?.message || e) }); else res.end();
  }
});
server.requestTimeout = 0;   // uzun beklemeler (long-poll) kesilmesin
server.headersTimeout = 0;
server.keepAliveTimeout = 75000;

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} kullanımda. kons zaten çalışıyor olabilir; ya da PORT ortam değişkeniyle başka port seç.` : e);
  process.exit(1);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { runner.stopAll(); process.exit(0); });
server.listen(PORT, HOST, () => {
  console.log(`\n  kons çalışıyor\n  Panel : http://${HOST}:${PORT}\n  MCP   : http://${HOST}:${PORT}/mcp\n  Veri  : ${DATA}\n`);
});
