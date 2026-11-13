// kons — yapay zekâ ajanları için sohbet merkezi.
//   Tarayıcı paneli : http://127.0.0.1:4700
//   Ajanlar (MCP)   : http://127.0.0.1:4700/mcp
// Erişim kipleri (yerel / paylaşımlı) için: lib/auth.js ve SECURITY.md
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Hub, HubError } from './lib/hub.js';
import { Auth } from './lib/auth.js';
import { handleMcp } from './lib/mcp.js';
import { handleAgentApi } from './lib/rest.js';
import { Runner } from './lib/runner.js';
import { buildState, olderMessages, exportRoom, runAction } from './lib/admin.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4700;
const HOST = process.env.HOST || '127.0.0.1';
const DATA = process.env.KONS_DATA || path.join(ROOT, 'data');

const auth = new Auth({ host: HOST, key: process.env.KONS_KEY, guestKey: process.env.KONS_GUEST_KEY });
const problem = auth.problem();
if (problem) { console.error(`\n${problem}\n`); process.exit(1); }

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
// Panel yalnızca kendi dosyalarını yükler; başka sitenin içine gömülemez.
const SECURE = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
const json = (res, code, obj, extra = {}) => res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra }).end(JSON.stringify(obj));

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 4e6) throw new HubError('İstek çok büyük.'); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new HubError('Geçersiz JSON.'); }
}
const isJson = (req) => String(req.headers['content-type'] || '').includes('application/json');

const server = http.createServer(async (req, res) => {
  try {
    if (!auth.originOk(req)) return json(res, 403, { error: auth.shared ? 'İstek başka bir siteden geliyor; reddedildi.' : 'Yalnızca yerel erişim.' });
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    // --- ajan kapıları: paylaşımlı kipte erişim anahtarı ister
    if (p === '/mcp') {
      const body = req.method === 'POST' ? await readBody(req) : null;
      const deny = auth.denyAgent(req, url, null);
      if (deny) return json(res, deny.code, { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32001, message: deny.text } });
      return await handleMcp(hub, req, res, url, body);
    }
    if (p.startsWith('/api/agent/')) {
      const body = req.method === 'POST' ? await readBody(req) : {};
      if (p === '/api/agent/join' || body.tool === 'join') { // sonraki çağrılar, katılırken verilen tahmin edilemez kimlikle (token) yapılır
        const deny = auth.denyAgent(req, url, body, false);
        if (deny) return json(res, deny.code, { ok: false, text: `⚠ ${deny.text}` });
      }
      delete body.key;
      return await handleAgentApi(hub, req, res, p, body);
    }
    // Ajanların talimatı ve istemciyi doğrudan sunucudan alabilmesi için (gizli bilgi içermez)
    if (p === '/AGENTS.md') return res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' }).end(await readFile(path.join(ROOT, 'AGENTS.md')));
    if (p === '/kons.mjs') return res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(await readFile(path.join(ROOT, 'client', 'kons.mjs')));

    // --- panel
    if (p === '/api/login' && req.method === 'POST') {
      if (!isJson(req)) return json(res, 415, { error: 'application/json gerekli.' });
      const r = auth.login(hub, req, await readBody(req));
      if (r.code === 200 && r.body.name) hub.log(r.body.name, 'giriş', r.body.role === 'admin' ? 'yönetici' : 'misafir');
      return json(res, r.code, r.body, r.cookie ? { 'Set-Cookie': r.cookie } : {});
    }
    if (p === '/api/logout' && req.method === 'POST') return json(res, 200, { ok: true }, { 'Set-Cookie': auth.logout(req) });

    if (p.startsWith('/api/')) {
      const user = auth.user(req);
      if (!user) return json(res, 401, { error: 'Giriş gerekli.', login: true });
      const admin = user.role === 'admin';

      if (p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('data: r\n\n');
        viewers.add(res);
        req.on('close', () => viewers.delete(res));
        return;
      }
      if (p === '/api/state') {
        const st = buildState(hub, url.searchParams.get('room'));
        // Misafire çalıştırıcı komutları ve bu bilgisayarın dosya yolları gösterilmez.
        if (!admin) st.agents = st.agents.map((a) => ({ ...a, runner: a.runner ? { on: a.runner.on, runs: a.runner.runs } : null }));
        return json(res, 200, { ...st, me: { shared: auth.shared, role: user.role, name: user.name || hub.human }, ...(admin ? { bridge: path.join(ROOT, 'bridge.mjs'), root: ROOT } : {}) });
      }
      if (p === '/api/messages') return json(res, 200, olderMessages(hub, url.searchParams.get('room'), url.searchParams.get('before')));
      if (p === '/api/run') return admin ? json(res, 200, runner.view(Number(url.searchParams.get('id'))) || {}) : json(res, 403, { error: 'Bu işlem için yönetici yetkisi gerekir.' });
      if (p === '/api/log') return json(res, 200, hub.all('SELECT * FROM events ORDER BY id DESC LIMIT 200'));
      if (p === '/api/export') {
        const fmt = url.searchParams.get('format') === 'json' ? 'json' : 'md';
        const room = hub.requireRoom(url.searchParams.get('room')).id;
        res.writeHead(200, { 'Content-Type': fmt === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="kons-${room}.${fmt}"`, 'X-Content-Type-Options': 'nosniff' });
        return res.end(exportRoom(hub, room, fmt));
      }
      if (p === '/api/action' && req.method === 'POST') {
        if (!isJson(req)) return json(res, 415, { error: 'application/json gerekli.' });
        return json(res, 200, { ok: true, ...runAction(hub, await readBody(req), runner, user) });
      }
      return json(res, 404, { error: 'Bulunamadı.' });
    }

    if (req.method === 'GET') {
      const file = p === '/' ? 'index.html' : p.slice(1);
      const full = path.join(ROOT, 'public', file);
      if (full.startsWith(path.join(ROOT, 'public') + path.sep) && TYPES[path.extname(full)]) {
        const data = await readFile(full).catch(() => null); // önce oku: bulunamazsa 404 dönebilelim
        if (data) return res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)], 'Cache-Control': 'no-cache', ...SECURE }).end(data);
      }
    }
    json(res, 404, { error: 'Bulunamadı.' });
  } catch (e) {
    if (e instanceof HubError) return json(res, 400, { error: e.message });
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Sunucu hatası.' }); else res.end();
  }
});
server.requestTimeout = 0;   // uzun beklemeler (long-poll) kesilmesin
server.headersTimeout = 0;
server.keepAliveTimeout = 75000;

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} kullanımda. kons zaten çalışıyor olabilir; ya da PORT ortam değişkeniyle başka port seç.` : e);
  process.exit(1);
});
// Ajan süreçleri ayrı süreç grubunda (detached): sunucu hangi yolla kapanırsa kapansın onları da sonlandır.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { runner.stopAll(); process.exit(0); });
process.on('exit', () => runner.stopAll());
server.listen(PORT, HOST, () => {
  const mode = auth.shared
    ? `PAYLAŞIMLI — giriş ve ajan katılımı anahtar ister${auth.guestKey ? ' (misafir anahtarı tanımlı)' : ''}.\n          İnternete açacaksan yalnızca HTTPS veren bir tünel/vekil arkasında kullan.`
    : 'YEREL — yalnızca bu bilgisayardan erişilir, giriş yok.';
  console.log(`\n  kons çalışıyor\n  Panel : http://${HOST}:${PORT}\n  MCP   : http://${HOST}:${PORT}/mcp\n  Veri  : ${DATA}\n  Erişim: ${mode}\n`);
});
