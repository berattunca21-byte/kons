// Güvenlik testi: sunucuyu geçici veriyle kendisi başlatır.  Çalıştır:  npm run test:security
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = 'yonetici-anahtari-0123456789', GUEST = 'misafir-anahtari-0123456789';
const tmp = mkdtempSync(path.join(os.tmpdir(), 'kons-sec-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const check = (name, cond, extra = '') => { cond ? passed++ : failed++; console.log(`${cond ? '  ok ' : 'FAIL '} ${name}${cond ? '' : '\n      ' + String(extra).slice(0, 300)}`); };

function start(env, port) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'],
    { cwd: ROOT, env: { ...process.env, KONS_KEY: '', KONS_GUEST_KEY: '', HOST: '', ...env, PORT: String(port), KONS_DATA: path.join(tmp, String(port)) } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  return { child, exited, out: () => out, ready: async () => { for (let i = 0; i < 60 && !out.includes('çalışıyor'); i++) await sleep(100); } };
}
const call = async (base, p, { method = 'GET', body, headers = {}, cookie } = {}) => {
  const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* json değil */ }
  return { status: r.status, j, cookie: (r.headers.get('set-cookie') || '').split(';')[0], headers: r.headers };
};
// fetch Host başlığını değiştirmeye izin vermez; DNS rebinding denemesi için ham istek
const rawGet = (port, p, headers) => new Promise((res) => { request({ host: '127.0.0.1', port, path: p, headers }, (r) => { r.resume(); res(r.statusCode); }).end(); });

// --- 1. güvensiz yapılandırma reddedilir
let s = start({ HOST: '0.0.0.0' }, 4781);
check('anahtarsız ağa açılma reddedilir', (await s.exited) === 1 && s.out().includes('GÜVENLİK'), s.out());
s = start({ KONS_KEY: 'kisa' }, 4781);
check('kısa anahtar reddedilir', (await s.exited) === 1, s.out());
s = start({ KONS_KEY: ADMIN, KONS_GUEST_KEY: ADMIN }, 4781);
check('misafir anahtarı yönetici anahtarıyla aynı olamaz', (await s.exited) === 1, s.out());

// --- 2. yerel kip
const L = 'http://127.0.0.1:4782';
const local = start({}, 4782); await local.ready();
check('yerel kip: giriş gerekmez', (await call(L, '/api/state')).status === 200);
check('yerel kip: yabancı Host başlığı reddedilir (DNS rebinding)', (await rawGet(4782, '/api/state', { Host: 'kotu.example.com' })) === 403);
check('yerel kip: başka siteden gelen istek reddedilir', (await call(L, '/api/action', { method: 'POST', body: { action: 'room_create', name: 'x' }, headers: { Origin: 'https://kotu.example.com' } })).status === 403);
check('düz metin gövdeyle eylem reddedilir (form CSRF)', (await fetch(L + '/api/action', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"action":"room_create","name":"x"}' })).status === 415);
const page = await fetch(L + '/');
check('panel güvenlik başlıklarıyla gelir', (page.headers.get('content-security-policy') || '').includes("default-src 'self'") && page.headers.get('x-frame-options') === 'DENY');
for (const u of ['/..%2fserver.js', '/..%5cserver.js', '/../server.js', '/%2e%2e%2fserver.js', '/app.js/../../server.js', '/%2e%2e/package.json']) {
  const body = await new Promise((res) => { request({ host: '127.0.0.1', port: 4782, path: u }, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => res(`${r.statusCode}:${d}`)); }).end(); });
  check(`public dışındaki dosya sunulmaz: ${u}`, body.startsWith('404:') && !body.includes('import '), body.slice(0, 80));
}
local.child.kill();

// --- 3. paylaşımlı kip
const B = 'http://127.0.0.1:4783';
const shared = start({ HOST: '0.0.0.0', KONS_KEY: ADMIN, KONS_GUEST_KEY: GUEST }, 4783); await shared.ready();
check('paylaşımlı kip başlar', shared.out().includes('PAYLAŞIMLI'), shared.out());
check('girişsiz durum okunamaz', (await call(B, '/api/state')).status === 401);
check('girişsiz eylem yapılamaz', (await call(B, '/api/action', { method: 'POST', body: { action: 'room_create', name: 'x' } })).status === 401);
check('girişsiz canlı akış açılamaz', (await call(B, '/api/events')).status === 401);
check('girişsiz dışa aktarım yapılamaz', (await call(B, '/api/export?room=genel')).status === 401);
check('anahtarsız ajan katılamaz', (await call(B, '/api/agent/join', { method: 'POST', body: { name: 'Sizan' } })).status === 401);
check('anahtarsız ajan "call" üzerinden de katılamaz', (await call(B, '/api/agent/call', { method: 'POST', body: { tool: 'join', args: { name: 'Sizan' } } })).status === 401);
check('uydurma kimlikle araç çağrılamaz', (await call(B, '/api/agent/call', { method: 'POST', body: { tool: 'send_message', args: { text: 'x' } }, headers: { Authorization: 'Bearer uydurma' } })).j?.ok === false);
check('anahtarsız MCP reddedilir', (await call(B, '/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status === 401);
check('yanlış anahtarla giriş reddedilir', (await call(B, '/api/login', { method: 'POST', body: { key: 'yanlis-anahtar-000000', name: 'Ali' } })).status === 401);

const admin = await call(B, '/api/login', { method: 'POST', body: { key: ADMIN, name: 'Patron' } });
check('yönetici girişi', admin.status === 200 && admin.j.role === 'admin' && admin.cookie.startsWith('kons_s='), JSON.stringify(admin.j));
check('oturum çerezi betiklerden gizli ve siteler arası gönderilmez', /HttpOnly/.test(admin.headers.get('set-cookie')) && /SameSite=Strict/.test(admin.headers.get('set-cookie')));
const guest = await call(B, '/api/login', { method: 'POST', body: { key: GUEST, name: 'Konuk' } });
check('misafir girişi', guest.status === 200 && guest.j.role === 'guest', JSON.stringify(guest.j));
check('misafir yönetici adını alamaz', (await call(B, '/api/login', { method: 'POST', body: { key: GUEST, name: 'Yönetici' } })).status === 400);

const A = { cookie: admin.cookie }, G = { cookie: guest.cookie };
const cmd = `"${process.execPath}" -e "console.log('-')"`;
check('yönetici ajan başlatabilir', (await call(B, '/api/action', { ...A, method: 'POST', body: { action: 'agent_spawn', room: 'genel', name: 'Robo', start: cmd } })).status === 200);
check('misafir ajan adını alamaz', (await call(B, '/api/login', { method: 'POST', body: { key: GUEST, name: 'Robo' } })).status === 400);
for (const action of ['agent_spawn', 'agent_runner', 'agent_run', 'settings_update', 'room_delete', 'room_clear', 'room_update', 'room_lead', 'agent_delete', 'room_create']) {
  const r = await call(B, '/api/action', { ...G, method: 'POST', body: { action, room: 'genel', id: 1, name: 'Kotu', start: 'calc', settings: {} } });
  check(`misafir yapamaz: ${action}`, r.status === 400 && /yönetici yetkisi/.test(r.j.error), JSON.stringify(r.j));
}
check('misafir son turun komutunu/çıktısını göremez', (await call(B, '/api/run?id=1', G)).status === 403);
const gs = (await call(B, '/api/state', G)).j;
check('misafire komutlar ve dosya yolları gösterilmez', !JSON.stringify(gs).includes('console.log') && gs.root === undefined && gs.bridge === undefined && gs.agents[0].runner.start === undefined, JSON.stringify(gs.agents[0].runner));
check('yönetici komutu görür', (await call(B, '/api/state', A)).j.agents[0].runner.start === cmd);
await call(B, '/api/action', { ...G, method: 'POST', body: { action: 'send', room: 'genel', text: 'merhaba' } });
await call(B, '/api/action', { ...G, method: 'POST', body: { action: 'task_create', room: 'genel', title: 'deneme' } });
const st = (await call(B, '/api/state', A)).j;
check('misafir kendi adıyla yazar ve görev ekler', st.messages.some((m) => m.from_name === 'Konuk' && m.from_kind === 'human' && m.text === 'merhaba') && st.tasks[0]?.created_by === 'Konuk', JSON.stringify(st.tasks));
check('başka siteden çerezli istek reddedilir', (await call(B, '/api/action', { ...A, method: 'POST', body: { action: 'room_create', name: 'x' }, headers: { Origin: 'https://kotu.example.com' } })).status === 403);

const j = await call(B, '/api/agent/join', { method: 'POST', body: { name: 'Uzak', room: 'genel' }, headers: { 'x-kons-key': GUEST } });
check('ajan misafir anahtarıyla katılır', j.status === 200 && !!j.j.token, JSON.stringify(j.j).slice(0, 200));
check('ajan sonra yalnızca kendi kimliğiyle çalışır', (await call(B, '/api/agent/call', { method: 'POST', body: { tool: 'list_agents' }, headers: { Authorization: `Bearer ${j.j.token}` } })).j?.ok === true);
check('MCP anahtarla açılır', (await call(B, '/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { 'x-kons-key': GUEST } })).j?.result?.tools?.length > 10);

await call(B, '/api/logout', { ...G, method: 'POST' });
check('çıkıştan sonra oturum geçersiz', (await call(B, '/api/state', G)).status === 401);

for (let i = 0; i < 8; i++) await call(B, '/api/login', { method: 'POST', body: { key: `deneme-anahtari-${i}-000000`, name: 'x' } });
check('art arda hatalı denemede giriş kilitlenir', (await call(B, '/api/login', { method: 'POST', body: { key: ADMIN, name: 'Patron' } })).status === 429);
shared.child.kill();

await sleep(300);
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows dosyayı bırakmamış olabilir */ }
console.log(`\n${passed} geçti, ${failed} kaldı`);
process.exit(failed ? 1 : 0);
