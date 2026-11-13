// Düz HTTP kapısı: MCP kurmadan, komut çalıştırabilen her ajan (kons.mjs, curl, fetch…) buradan bağlanır.
//   POST /api/agent/join  {name, role?, room?, max_wait_sec?}        → {ok, token, text}
//   POST /api/agent/call  {tool, args}   Authorization: Bearer <token> → {ok, text}
// Araçlar MCP ile aynıdır; token, MCP'deki oturum kimliğinin karşılığıdır.
import { randomUUID } from 'node:crypto';
import { startTool } from './mcp.js';

const HEAD = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

export async function handleAgentApi(hub, req, res, p, body) {
  const bearer = /^Bearer\s+(\S+)/i.exec(req.headers.authorization || '')?.[1] || null;
  const send = (code, obj) => res.writeHead(code, HEAD).end(JSON.stringify(obj));
  if (req.method !== 'POST') return send(405, { ok: false, text: 'POST gerekli.' });

  const isJoin = p === '/api/agent/join' || body.tool === 'join';
  if (isJoin) {
    const sid = bearer || randomUUID();
    const a = body.args || body;
    hub.clients.set(sid, String(body.client || a.client || 'http').slice(0, 60));
    const r = await startTool(hub, sid, 'join', { name: a.name, role: a.role, room: a.room, max_wait_sec: a.max_wait_sec }).promise;
    return send(r.isError ? 400 : 200, { ok: !r.isError, ...(r.isError ? {} : { token: sid }), text: r.text });
  }

  if (!bearer) return send(401, { ok: false, text: '⚠ Kimlik yok. Önce katıl (join), sonra her istekte "Authorization: Bearer <token>" gönder.' });
  const t = startTool(hub, bearer, String(body.tool || ''), body.args || {});
  // Uzun bekleme: başlığı hemen gönder, bağlantı zaman aşımına düşmesin diye arada boşluk yaz (JSON'da baştaki boşluk geçerlidir).
  res.writeHead(200, HEAD);
  res.write(' ');
  const beat = setInterval(() => res.write(' '), 15000);
  res.on('close', () => { clearInterval(beat); t.cancel(); });
  const r = await t.promise;
  clearInterval(beat);
  if (!res.destroyed) res.end(JSON.stringify({ ok: !r.isError, text: r.text }));
}
