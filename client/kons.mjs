#!/usr/bin/env node
// kons istemcisi — bağımlılıksız. Komut çalıştırabilen her ajan bununla sohbete katılır.
//   node kons.mjs join --name Ali --role "programcı" --room oyun
//   node kons.mjs --as Ali wait
//   node kons.mjs --as Ali say "merhaba"
// Tüm komutlar: node kons.mjs help
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.KONS_HOME || path.join(os.homedir(), '.kons');
const HELP = `kons — ajan sohbet istemcisi

KATIL
  join --name AD [--role ROL] [--room ODA] [--max-wait SN]   kimliği ${path.join(HOME, '<ad>.json')} dosyasına kaydeder

Sonraki her komutta kim olduğunu söyle:  node kons.mjs --as AD <komut>   (ya da KONS_AGENT=AD)

SOHBET
  wait [--timeout SN]                 yeni mesaj gelene kadar bekle, gelenleri yazdır  ← sohbette kalmanın yolu
  say "metin" [--to AD] [--reply N]   mesaj gönder (--to: özel mesaj). Metin "-" ise stdin'den okunur
  ask "soru"                          yöneticiye (insana) soru sor
  history [-n 30] [--before N] [--search METİN]
  who                                 odadakiler ve durumları
  team                                kim ne yapıyor: görevler, kilitler, son mesajlar
  status "ne yapıyorum" [--wake all|mentions]
  leave

GÖREVLER
  tasks [--status todo|doing|review|done|blocked]
  task-add "başlık" [--desc "açıklama"] [--to AD]
  task-claim N
  task-update N [--status DURUM] [--to AD] [--note "not"]

ORTAK NOTLAR
  notes | note-read ANAHTAR | note-write ANAHTAR "içerik" [--append]   (içerik "-" ise stdin)

DOSYA KİLİTLERİ
  lock YOL [YOL…] [--note "ne yapıyorum"] | unlock [YOL…] | locks

GENEL
  --server URL   sunucu adresi (varsayılan: KONS_URL ya da http://127.0.0.1:4700)
  --json         yanıtı ham JSON olarak yazdır
`;

// --- argümanlar
const FLAGS = new Set(['append', 'json', 'help']);
const opt = {}, pos = [];
const raw = process.argv.slice(2);
for (let i = 0; i < raw.length; i++) {
  const a = raw[i];
  if (a === '-n') opt.limit = raw[++i];
  else if (a.startsWith('--') && a.length > 2) { const k = a.slice(2); opt[k] = FLAGS.has(k) ? true : raw[++i]; }
  else pos.push(a);
}
const die = (msg) => { console.error(msg); process.exit(1); };
const num = (v) => (v === undefined ? undefined : Number(v));
const stdin = () => readFileSync(0, 'utf8').replace(/\r\n/g, '\n').trimEnd();
const text = (parts) => { const t = parts.join(' '); return t === '-' ? stdin() : t; };

const ALIAS = { wait_for_messages: 'wait', send_message: 'say', ask_human: 'ask', read_history: 'history', list_agents: 'who', set_status: 'status',
  team_overview: 'team', task_list: 'tasks', task_create: 'task-add', task_claim: 'task-claim', task_update: 'task-update', note_list: 'notes', note_read: 'note-read',
  note_write: 'note-write', lock_acquire: 'lock', lock_release: 'unlock', lock_list: 'locks' };
const cmd = ALIAS[pos[0]] || pos[0];
const rest = pos.slice(1);
if (!cmd || cmd === 'help' || opt.help) { console.log(HELP); process.exit(0); }

const COMMANDS = {
  wait: () => ['wait_for_messages', { timeout_sec: num(opt.timeout) }],
  say: () => ['send_message', { text: text(rest), to: opt.to, reply_to: num(opt.reply) }],
  ask: () => ['ask_human', { question: text(rest) }],
  history: () => ['read_history', { limit: num(opt.limit), before_id: num(opt.before), search: opt.search }],
  who: () => ['list_agents', {}],
  team: () => ['team_overview', {}],
  status: () => ['set_status', { status: rest.length ? rest.join(' ') : undefined, wake: opt.wake }],
  leave: () => ['leave', { reason: rest.join(' ') || undefined }],
  tasks: () => ['task_list', { status: opt.status }],
  'task-add': () => ['task_create', { title: rest.join(' '), description: opt.desc, assignee: opt.to }],
  'task-claim': () => ['task_claim', { id: num(rest[0]) }],
  'task-update': () => ['task_update', { id: num(rest[0]), status: opt.status, assignee: opt.to, note: opt.note }],
  notes: () => ['note_list', {}],
  'note-read': () => ['note_read', { key: rest[0] }],
  'note-write': () => ['note_write', { key: rest[0], content: text(rest.slice(1)), append: !!opt.append }],
  lock: () => ['lock_acquire', { paths: rest, note: opt.note }],
  unlock: () => ['lock_release', { paths: rest }],
  locks: () => ['lock_list', {}],
};

// --- kimlik dosyaları
const fileFor = (name) => path.join(HOME, `${String(name).toLocaleLowerCase('tr').replace(/[^\p{L}\p{N}_.-]/gu, '_')}.json`);
function identity() {
  // Sistem tarafından çalıştırılan ajanlarda kimlik ortam değişkeniyle gelir.
  if (!opt.as && process.env.KONS_TOKEN) return { name: process.env.KONS_AGENT, server: process.env.KONS_URL || 'http://127.0.0.1:4700', token: process.env.KONS_TOKEN };
  const who = opt.as || process.env.KONS_AGENT;
  if (who) {
    if (!existsSync(fileFor(who))) die(`"${who}" için kayıtlı kimlik yok. Önce: node kons.mjs join --name ${who}`);
    return JSON.parse(readFileSync(fileFor(who), 'utf8'));
  }
  const all = existsSync(HOME) ? readdirSync(HOME).filter((f) => f.endsWith('.json')) : [];
  if (all.length === 1) return JSON.parse(readFileSync(path.join(HOME, all[0]), 'utf8'));
  if (!all.length) die('Henüz katılmadın. Önce: node kons.mjs join --name AD --role ROL --room ODA');
  die(`Bu bilgisayarda birden çok ajan kimliği var (${all.map((f) => f.slice(0, -5)).join(', ')}). Hangisi olduğunu söyle: node kons.mjs --as AD ${cmd}`);
}

async function post(server, pathname, body, token) {
  let res;
  try {
    res = await fetch(server.replace(/\/+$/, '') + pathname, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  } catch (e) { die(`kons sunucusuna ulaşılamadı (${server}). Sunucu çalışıyor mu? ${e.cause?.code || e.message}`); }
  const raw = await res.text();
  try { return JSON.parse(raw); } catch { die(`Sunucudan beklenmeyen yanıt (${res.status}): ${raw.slice(0, 300)}`); }
}
const finish = (r) => { console.log(opt.json ? JSON.stringify(r) : r.text); process.exit(r.ok ? 0 : 1); };

if (cmd === 'join') {
  const name = opt.name || rest[0] || die('Ad gerekli: node kons.mjs join --name AD [--role ROL] [--room ODA]');
  const server = opt.server || process.env.KONS_URL || 'http://127.0.0.1:4700';
  const old = existsSync(fileFor(name)) ? JSON.parse(readFileSync(fileFor(name), 'utf8')) : null;
  const r = await post(server, '/api/agent/join', { name, role: opt.role, room: opt.room, max_wait_sec: num(opt['max-wait']), client: 'kons-cli' }, old?.server === server ? old.token : null);
  if (r.ok) {
    mkdirSync(HOME, { recursive: true });
    writeFileSync(fileFor(name), JSON.stringify({ name, server, token: r.token }, null, 2));
    r.text += `\n\nBU İSTEMCİDE: araç adları komut olarak da geçerlidir. Sıradaki komutun:\n  node "${process.argv[1]}" --as ${name} wait\nSonraki her komutta --as ${name} kullan.`;
  }
  finish(r);
}
if (!COMMANDS[cmd]) die(`Bilinmeyen komut: ${cmd}\n\n${HELP}`);
const me = identity();
const [tool, args] = COMMANDS[cmd]();
finish(await post(opt.server || me.server, '/api/agent/call', { tool, args }, me.token));
