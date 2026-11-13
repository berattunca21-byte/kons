// Çekirdek: odalar, ajanlar, mesajlar, bekleyenler (long-poll), görevler, notlar, kilitler.
import { EventEmitter } from 'node:events';
import { openDb } from './db.js';

export const DEFAULTS = {
  human_name: 'Yönetici',
  wait_timeout_sec: 240,   // wait_for_messages en fazla bu kadar bekler, sonra "mesaj yok" döner
  min_interval_sec: 1,     // bir ajanın iki mesajı arasındaki en kısa süre
  auto_pause_after: 60,    // insan yazmadan art arda bu kadar ajan mesajı olursa odayı duraklat (0 = kapalı)
  run_timeout_min: 30,     // çalıştırıcı: tek bir tur en fazla bu kadar sürer
  nudge_idle_min: 10,      // koordinatör: açık görev varken bu kadar dakika sessizlik olursa dürt (0 = kapalı)
  history_on_join: 20,     // katılan ajana gösterilen son mesaj sayısı
};
export const TASK_STATUSES = ['todo', 'doing', 'review', 'done', 'blocked'];
const RESERVED = ['sistem', 'system', 'herkes', 'all', 'everyone', 'hepiniz', 'sen', 'ben'];
const EVERYONE = ['herkes', 'all', 'everyone', 'hepiniz'];
const MAX_TEXT = 8000;
const MAX_DELIVER = 30;
const MAX_NUDGES = 3;

export const LEAD_BRIEF = `👑 BU ODANIN KOORDİNATÖRÜSÜN. Görevin işi yapmak değil, ekibi çalıştırmak:
• Yöneticinin hedefini küçük, net, bağımsız görevlere böl: task_create ile oluştur ve her birini uygun üyeye ata (assignee). Kabul ölçütünü açıklamaya yaz.
• Ortak kararları (mimari, dosya yapısı, arayüz sözleşmeleri) note_write ile nota yaz ki herkes aynı şeye baksın.
• team_overview ile kimin ne yaptığını izle. Biten işi kontrol et, sıradaki görevi ata. Tıkanan ya da sessiz kalan üyeye @Ad ile seslen.
• Üyeler yalnızca kendilerine seslenildiğinde ya da görev atandığında uyanır; odadaki her mesajı yalnızca sen duyarsın. Birinden bir şey istiyorsan @Ad yaz.
• Yöneticiye kısa ilerleme özetleri ver; yalnızca onun karar vermesi gereken konularda ask_human kullan.
• Tüm görevler bitince sonucu özetle ve dur; yeni iş uydurma.`;

export class HubError extends Error {}
const fail = (m) => { throw new HubError(m); };
const now = () => Date.now();
const lower = (s) => String(s).toLocaleLowerCase('tr');

export const slugify = (s) => lower(s || '')
  .replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export const cleanName = (n) => String(n || '').trim().replace(/^@/, '').replace(/\s+/g, '_')
  .replace(/[^\p{L}\p{N}_.-]/gu, '').replace(/[.-]+$/, '').slice(0, 24);

const normPath = (p) => String(p || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
const pathsOverlap = (a, b) => {
  a = a.toLowerCase(); b = b.toLowerCase();
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
};

export class Hub extends EventEmitter {
  constructor(dataDir) {
    super();
    this.db = openDb(dataDir);
    this.stmts = new Map();
    this.waiters = new Map();      // agentId -> bekleyen long-poll
    this.lastSent = new Map();     // agentId -> son mesaj zamanı
    this.workingSince = new Map(); // agentId -> son teslimden beri çalışıyor
    this.streak = new Map();       // roomId -> insan yazmadan art arda ajan mesajı
    this.clients = new Map();      // sid -> istemci adı
    this.running = new Set();      // çalıştırıcısı şu an tur atan ajanlar
    this.nudges = new Map();       // roomId -> art arda dürtme sayısı
    if (!this.get('SELECT id FROM rooms LIMIT 1')) this.createRoom('genel', 'Genel sohbet');
  }

  // --- sqlite yardımcıları
  q(sql) { let s = this.stmts.get(sql); if (!s) this.stmts.set(sql, s = this.db.prepare(sql)); return s; }
  get(sql, ...p) { return this.q(sql).get(...p); }
  all(sql, ...p) { return this.q(sql).all(...p); }
  run(sql, ...p) { return this.q(sql).run(...p); }
  changed() { this.emit('refresh'); }
  log(who, type, detail = '') {
    const r = this.run('INSERT INTO events(ts,who,type,detail) VALUES(?,?,?,?)', now(), who, type, String(detail).slice(0, 500));
    if (Number(r.lastInsertRowid) % 500 === 0) this.run('DELETE FROM events WHERE id < ?', Number(r.lastInsertRowid) - 3000);
  }

  // --- ayarlar
  settings() {
    const s = { ...DEFAULTS };
    for (const r of this.all('SELECT key,value FROM settings')) if (r.key in s) s[r.key] = JSON.parse(r.value);
    return s;
  }
  setSettings(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in DEFAULTS)) continue;
      let val = v;
      if (k === 'human_name') {
        val = cleanName(v);
        if (!val || RESERVED.includes(lower(val))) fail('Geçersiz yönetici adı.');
        if (this.get('SELECT id FROM agents WHERE name=?', val)) fail('Bu ad bir ajan tarafından kullanılıyor.');
      } else {
        val = Math.max(0, Math.floor(Number(v)));
        if (!Number.isFinite(val)) fail(`${k} sayı olmalı.`);
        if (k === 'wait_timeout_sec') val = Math.min(3600, Math.max(10, val));
      }
      this.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, JSON.stringify(val));
    }
    this.log('yönetici', 'ayarlar', JSON.stringify(patch));
    this.changed();
  }
  get human() { return this.settings().human_name; }

  // --- odalar
  room(id) { return this.get('SELECT * FROM rooms WHERE id=?', id); }
  requireRoom(id) { return this.room(id) || fail(`Oda bulunamadı: ${id}`); }
  createRoom(name, topic = '', brief = '') {
    const id = slugify(name);
    if (!id) fail('Oda adı boş olamaz.');
    if (this.room(id)) fail(`"${id}" adlı oda zaten var.`);
    this.run('INSERT INTO rooms(id,name,topic,brief,created_at) VALUES(?,?,?,?,?)', id, String(name).trim().slice(0, 60), String(topic).slice(0, 300), String(brief).slice(0, 20000), now());
    this.changed();
    return id;
  }
  updateRoom(id, { topic, brief, name }) {
    const r = this.requireRoom(id);
    this.run('UPDATE rooms SET name=?, topic=?, brief=? WHERE id=?',
      name != null && String(name).trim() ? String(name).trim().slice(0, 60) : r.name,
      topic != null ? String(topic).slice(0, 300) : r.topic,
      brief != null ? String(brief).slice(0, 20000) : r.brief, id);
    if (brief != null && brief !== r.brief) {
      this.post({ roomId: id, from: 'sistem', fromKind: 'system', mentions: ['*'],
        text: `📌 Oda brifi güncellendi (yöneticinin talimatı):\n${brief || '(boş)'}` });
    }
    this.changed();
  }
  setPaused(id, paused, why = '') {
    this.requireRoom(id);
    this.run('UPDATE rooms SET paused=? WHERE id=?', paused ? 1 : 0, id);
    this.streak.set(id, 0);
    this.post({ roomId: id, from: 'sistem', fromKind: 'system', mentions: paused ? [] : ['*'], quiet: !!paused,
      text: paused ? `⏸ Oda duraklatıldı${why ? ' — ' + why : ''}. Ajanlar mesaj gönderemez; beklemeye devam edin.` : '▶ Oda devam ediyor. Kaldığınız yerden sürdürün.' });
  }
  deleteRoom(id) {
    this.requireRoom(id);
    if (this.get('SELECT COUNT(*) c FROM rooms').c <= 1) fail('Son oda silinemez.');
    for (const a of this.roomAgents(id)) this.dismiss(a.id, 'oda silindi');
    for (const t of ['messages', 'tasks', 'notes', 'locks']) this.run(`DELETE FROM ${t} WHERE room_id=?`, id);
    this.run('DELETE FROM rooms WHERE id=?', id);
    this.changed();
  }
  clearRoom(id) {
    this.requireRoom(id);
    this.run('DELETE FROM messages WHERE room_id=?', id);
    this.changed();
  }

  // --- ajanlar
  agentById(id) { return this.get('SELECT * FROM agents WHERE id=?', id); }
  agentByName(name) { return this.get('SELECT * FROM agents WHERE name=?', name); }
  agentBySession(sid) {
    if (!sid) return null;
    return this.get('SELECT a.* FROM agents a JOIN sessions s ON s.agent_id=a.id WHERE s.sid=?', sid) || null;
  }
  roomAgents(roomId) { return this.all('SELECT * FROM agents WHERE room_id=? ORDER BY name', roomId); }
  runnerCfg(a) { try { return a.runner ? JSON.parse(a.runner) : null; } catch { return null; } }
  /** Odanın koordinatörü (odadaysa) */
  lead(roomId) {
    const r = this.room(roomId);
    if (!r?.lead) return null;
    const a = this.agentByName(r.lead);
    return a && a.room_id === roomId ? a.name : null;
  }
  setLead(roomId, name) {
    this.requireRoom(roomId);
    const a = name ? this.agentByName(cleanName(name)) : null;
    if (name && (!a || a.room_id !== roomId)) fail('Koordinatör bu odadaki bir ajan olmalı.');
    this.run('UPDATE rooms SET lead=? WHERE id=?', a ? a.name : null, roomId);
    this.post({ roomId, from: 'sistem', fromKind: 'system', mentions: a ? ['*'] : [], quiet: !a,
      text: a ? `👑 ${a.name} bu odanın koordinatörü oldu. Görevleri o dağıtır ve takip eder; işin bitince ya da tıkanınca ona haber ver (@${a.name}).\n\n@${a.name} için talimat:\n${LEAD_BRIEF}` : '👑 Koordinatör kaldırıldı; oda yeniden herkesin herkesi duyduğu düzende.' });
  }
  presence(a) {
    if (!a.room_id) return 'left';
    if (this.running.has(a.id)) return 'working';
    if (this.runnerCfg(a)?.on) return 'listening';
    if (this.waiters.has(a.id)) return 'listening';
    return now() - a.last_seen < 120000 ? 'working' : 'silent';
  }
  agentView(a) {
    const rc = this.runnerCfg(a);
    return { ...a, runner: rc ? { ...rc, token: undefined } : null, presence: this.presence(a), running: this.running.has(a.id),
      working_since: this.workingSince.get(a.id) || null, pending: a.room_id ? this.pendingCount(a) : 0 };
  }
  touch(agentId) { this.run('UPDATE agents SET last_seen=? WHERE id=?', now(), agentId); this.changed(); }

  join(sid, rawName, role, roomName, maxWaitSec) {
    if (!sid) fail('Oturum kimliği yok (Mcp-Session-Id). İstemci MCP oturumunu başlatmalı.');
    const name = cleanName(rawName);
    if (!name) fail('Geçerli bir ad ver (harf/rakam, boşluksuz, en fazla 24 karakter).');
    if (RESERVED.includes(lower(name)) || lower(name) === lower(this.human)) fail(`"${name}" adı ayrılmış; başka bir ad seç.`);
    let a = this.agentByName(name);
    const prev = this.agentBySession(sid);
    if (prev && (!a || prev.id !== a.id) && prev.room_id) this.dismiss(prev.id, 'başka bir adla yeniden katıldı', true);
    let roomId = roomName ? slugify(roomName) : (a?.room_id || this.get('SELECT id FROM rooms ORDER BY created_at LIMIT 1').id);
    if (!roomId) fail('Geçersiz oda adı.');
    if (!this.room(roomId)) roomId = this.createRoom(roomName);
    const top = this.get('SELECT COALESCE(MAX(id),0) m FROM messages').m;
    const rejoin = !!a && a.room_id === roomId && this.presence(a) !== 'silent';
    if (!a) {
      this.run('INSERT INTO agents(name,role,room_id,cursor,last_seen,client,created_at) VALUES(?,?,?,?,?,?,?)',
        name, String(role || '').slice(0, 60), roomId, top, now(), this.clients.get(sid) || '', now());
      a = this.agentByName(name);
    } else {
      this.cancelWait(a.id, 'superseded');
      if (a.room_id && a.room_id !== roomId) this.run('DELETE FROM locks WHERE room_id=? AND owner=?', a.room_id, a.name);
      this.run('UPDATE agents SET role=?, room_id=?, cursor=?, last_seen=?, client=? WHERE id=?',
        role ? String(role).slice(0, 60) : a.role, roomId, top, now(), this.clients.get(sid) || a.client, a.id);
      a = this.agentById(a.id);
    }
    this.run('INSERT INTO sessions(sid,agent_id) VALUES(?,?) ON CONFLICT(sid) DO UPDATE SET agent_id=excluded.agent_id', sid, a.id);
    // Bekleme süresi: ajan söylediyse o; yoksa araç zaman aşımı kısa olduğu bilinen istemcilerde (Codex ~60 sn) kısa tut.
    const asked = Math.floor(Number(maxWaitSec)) || 0;
    const auto = /codex|kons-cli|http/i.test(a.client) && !a.wait_sec ? 50 : 0;
    if (asked > 0 || auto) { this.run('UPDATE agents SET wait_sec=? WHERE id=?', Math.min(3600, Math.max(10, asked || auto)), a.id); a = this.agentById(a.id); }
    if (!rejoin) this.post({ roomId, from: 'sistem', fromKind: 'system', quiet: true, mentions: [],
      text: `➕ ${a.name}${a.role ? ` (${a.role})` : ''} odaya katıldı.` });
    this.log(a.name, 'katıldı', roomId);
    this.changed();
    return a;
  }

  /** Ajanı odadan çıkarır; bekliyorsa beklemesini "dismissed" ile bitirir. */
  dismiss(agentId, reason = '', silentWaiter = false) {
    const a = this.agentById(agentId);
    if (!a || !a.room_id) return;
    this.run('DELETE FROM locks WHERE room_id=? AND owner=?', a.room_id, a.name);
    this.run('UPDATE agents SET room_id=NULL, status=? WHERE id=?', '', a.id);
    this.workingSince.delete(a.id);
    this.cancelWait(a.id, silentWaiter ? 'superseded' : 'dismissed');
    this.post({ roomId: a.room_id, from: 'sistem', fromKind: 'system', quiet: true, mentions: [],
      text: `➖ ${a.name} odadan ayrıldı${reason ? ` (${reason})` : ''}.` });
    this.log(a.name, 'ayrıldı', reason);
  }
  deleteAgent(agentId) {
    this.dismiss(agentId, 'silindi');
    this.run('DELETE FROM sessions WHERE agent_id=?', agentId);
    this.run('DELETE FROM agents WHERE id=?', agentId);
    this.changed();
  }
  updateAgent(agentId, { muted, wake, role, status, wait_sec }) {
    const a = this.agentById(agentId) || fail('Ajan bulunamadı.');
    if (wake != null && !['all', 'mentions'].includes(wake)) fail('wake "all" ya da "mentions" olmalı.');
    let ws = a.wait_sec;
    if (wait_sec != null) { ws = Math.floor(Number(wait_sec)); if (!Number.isFinite(ws) || ws < 0) fail('Bekleme süresi 0 ya da pozitif sayı olmalı.'); ws = ws && Math.min(3600, Math.max(10, ws)); }
    this.run('UPDATE agents SET muted=?, wake=?, role=?, status=?, wait_sec=? WHERE id=?',
      muted != null ? (muted ? 1 : 0) : a.muted, wake ?? a.wake,
      role != null ? String(role).slice(0, 60) : a.role, status != null ? String(status).slice(0, 140) : a.status, ws, a.id);
    this.changed();
  }
  /** Bu ajan için tek bir beklemenin en uzun süresi (sn). İstemcinin araç zaman aşımından kısa olmalı. */
  waitSeconds(a) { return a.wait_sec > 0 ? a.wait_sec : this.settings().wait_timeout_sec; }

  // --- mesajlar
  row(r) { return r && { ...r, mentions: JSON.parse(r.mentions) }; }
  message(id) { return this.row(this.get('SELECT * FROM messages WHERE id=?', id)); }
  parseMentions(roomId, text) {
    const known = [...this.roomAgents(roomId).map((a) => a.name), this.human];
    const out = new Set();
    for (const m of String(text).matchAll(/@([\p{L}\p{N}_.-]+)/gu)) {
      const tok = lower(m[1].replace(/[.-]+$/, ''));
      if (EVERYONE.includes(tok)) out.add('*');
      else { const hit = known.find((n) => lower(n) === tok); if (hit) out.add(hit); }
    }
    return [...out];
  }
  post({ roomId, from, fromKind, text, to = null, kind = 'chat', replyTo = null, quiet = false, mentions }) {
    const m = new Set(mentions ?? this.parseMentions(roomId, text));
    if (replyTo) {
      const orig = this.message(replyTo);
      if (!orig || orig.room_id !== roomId) fail(`#${replyTo} numaralı mesaj bu odada yok.`);
      if (orig.from_kind !== 'system' && orig.from_name !== from) m.add(orig.from_name);
      if (orig.kind === 'question' && fromKind === 'human') this.run('UPDATE messages SET resolved=1 WHERE id=?', orig.id);
    }
    const r = this.run(
      'INSERT INTO messages(room_id,from_name,from_kind,to_name,kind,text,mentions,reply_to,quiet,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      roomId, from, fromKind, to, kind, text, JSON.stringify([...m]), replyTo, quiet ? 1 : 0, now());
    const msg = this.message(Number(r.lastInsertRowid));
    if (fromKind !== 'system') this.nudges.set(roomId, 0);
    this.emit('message', msg);
    for (const [agentId, w] of this.waiters) {
      const a = this.agentById(agentId);
      if (a && a.room_id === roomId && this.shouldWake(a, msg)) w.schedule();
    }
    return msg;
  }
  visible(a, m) { return m.from_name !== a.name && (!m.to_name || m.to_name === a.name); }
  /** Bu mesaj, beklemekte olan ajanı uyandırmalı mı? */
  shouldWake(a, m) {
    if (!this.visible(a, m)) return false;
    if (m.to_name) return true;
    if (m.mentions.includes(a.name) || m.mentions.includes('*')) return true;
    if (m.quiet || m.from_kind === 'system') return false;
    // Koordinatör varsa düzen "merkez ve kollar"dır: seslenilmeyen mesajları yalnızca koordinatör duyar.
    const lead = this.lead(a.room_id);
    if (lead) return lead === a.name && (m.from_kind !== 'human' || m.mentions.length === 0);
    if (m.from_kind === 'human') return m.mentions.length === 0; // yönetici belirli birine seslenmediyse herkese konuşuyordur
    return a.wake === 'all';
  }
  unread(a) {
    return this.all('SELECT * FROM messages WHERE room_id=? AND id>? AND from_name<>? AND (to_name IS NULL OR to_name=?) ORDER BY id',
      a.room_id, a.cursor, a.name, a.name).map((r) => this.row(r));
  }
  pendingCount(a) { return this.unread(a).filter((m) => this.shouldWake(a, m)).length; }
  deliver(a) {
    const all = this.unread(a);
    if (all.length) this.run('UPDATE agents SET cursor=? WHERE id=?', all[all.length - 1].id, a.id);
    this.workingSince.set(a.id, now());
    return { type: 'messages', messages: all.slice(-MAX_DELIVER), skipped: Math.max(0, all.length - MAX_DELIVER) };
  }
  history(a, { limit = 30, beforeId = null, search = null } = {}) {
    limit = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 30));
    const rows = this.all(
      `SELECT * FROM messages WHERE room_id=? AND (to_name IS NULL OR to_name=? OR from_name=?)
       AND (? IS NULL OR id<?) AND (? IS NULL OR text LIKE '%'||?||'%') ORDER BY id DESC LIMIT ?`,
      a.room_id, a.name, a.name, beforeId, beforeId, search, search, limit);
    return rows.reverse().map((r) => this.row(r));
  }

  agentSend(a, { text, to = null, replyTo = null, kind = 'chat' }) {
    text = String(text || '').trim();
    if (!text) fail('Boş mesaj gönderilemez.');
    if (text.length > MAX_TEXT) fail(`Mesaj çok uzun (${text.length} > ${MAX_TEXT} karakter). Uzun içerik için note_write kullan ve mesajda nota atıf yap.`);
    const room = this.requireRoom(a.room_id);
    const s = this.settings();
    if (a.muted) fail('Yönetici seni susturdu; mesaj gönderemezsin. wait_for_messages ile beklemeye devam et.');
    if (room.paused) fail('Oda duraklatıldı; şu an mesaj gönderilemez. wait_for_messages ile bekle, oda devam edince haber gelir.');
    const gap = s.min_interval_sec * 1000 - (now() - (this.lastSent.get(a.id) || 0));
    if (gap > 0) fail(`Çok hızlı yazıyorsun; ${Math.ceil(gap / 1000)} sn sonra tekrar dene. Mesajlarını tek mesajda topla.`);
    let toName = null;
    if (to) {
      const t = cleanName(to);
      if (lower(t) === lower(s.human)) toName = s.human;
      else if (!EVERYONE.includes(lower(t))) {
        const target = this.agentByName(t);
        if (!target || target.room_id !== a.room_id) fail(`"${to}" bu odada değil. list_agents ile üyeleri gör.`);
        if (target.id === a.id) fail('Kendine özel mesaj gönderemezsin.');
        toName = target.name;
      }
    }
    const msg = this.post({ roomId: a.room_id, from: a.name, fromKind: 'agent', text, to: toName, kind, replyTo: replyTo ? Number(replyTo) : null });
    this.lastSent.set(a.id, now());
    const n = (this.streak.get(a.room_id) || 0) + 1;
    this.streak.set(a.room_id, n);
    if (s.auto_pause_after > 0 && n >= s.auto_pause_after) this.setPaused(a.room_id, true, `yönetici yazmadan ${n} ajan mesajı (otomatik fren)`);
    return msg;
  }
  humanSend(roomId, { text, to = null, replyTo = null }, name = this.human) {
    text = String(text || '').trim();
    if (!text) fail('Boş mesaj.');
    this.requireRoom(roomId);
    let toName = null;
    if (to) { const t = this.agentByName(cleanName(to)); if (!t) fail('Ajan bulunamadı.'); toName = t.name; }
    this.streak.set(roomId, 0);
    return this.post({ roomId, from: name, fromKind: 'human', text: text.slice(0, 50000), to: toName, replyTo: replyTo ? Number(replyTo) : null });
  }

  // --- bekleme (long-poll)
  cancelWait(agentId, type) { this.waiters.get(agentId)?.finish({ type }); }
  /** { promise, cancel } döner. promise: {type:'messages'|'timeout'|'dismissed'|'superseded'|'cancelled'} */
  wait(agentId, timeoutSec) {
    this.cancelWait(agentId, 'superseded');
    const a = this.agentById(agentId);
    this.run('UPDATE agents SET last_seen=? WHERE id=?', now(), agentId);
    if (this.runnerCfg(a)?.on) return { promise: Promise.resolve({ type: 'managed' }), cancel() {} };
    if (this.pendingCount(a) > 0) { const res = this.deliver(a); this.changed(); return { promise: Promise.resolve(res), cancel() {} }; }
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const w = { done: false, debounce: null };
    w.finish = (res) => {
      if (w.done) return;
      w.done = true;
      clearTimeout(w.timer); clearTimeout(w.debounce);
      if (this.waiters.get(agentId) === w) this.waiters.delete(agentId);
      this.run('UPDATE agents SET last_seen=? WHERE id=?', now(), agentId);
      this.changed();
      resolve(res);
    };
    // kısa bir gecikme: art arda gelen mesajlar tek seferde teslim edilsin
    w.schedule = () => { if (!w.debounce && !w.done) w.debounce = setTimeout(() => { const cur = this.agentById(agentId); w.finish(cur?.room_id ? this.deliver(cur) : { type: 'dismissed' }); }, 300); };
    w.timer = setTimeout(() => w.finish({ type: 'timeout' }), timeoutSec * 1000);
    this.waiters.set(agentId, w);
    this.workingSince.delete(agentId);
    this.changed();
    return { promise, cancel: () => w.finish({ type: 'cancelled' }) };
  }

  /** Koordinatörü dürt: açık görev varken oda uzun süre sessiz kaldıysa. Düzenli aralıkla çağrılır. */
  nudgeIdle() {
    const mins = this.settings().nudge_idle_min;
    if (!mins) return;
    for (const r of this.all('SELECT * FROM rooms WHERE paused=0 AND lead IS NOT NULL')) {
      const lead = this.lead(r.id);
      if (!lead || (this.nudges.get(r.id) || 0) >= MAX_NUDGES) continue;
      const open = this.tasks(r.id).filter((t) => t.status !== 'done');
      if (!open.length || this.roomAgents(r.id).some((a) => this.running.has(a.id))) continue;
      const last = this.get('SELECT MAX(created_at) t FROM messages WHERE room_id=?', r.id).t || 0;
      if (now() - last < mins * 60000) continue;
      this.nudges.set(r.id, (this.nudges.get(r.id) || 0) + 1);
      this.post({ roomId: r.id, from: 'sistem', fromKind: 'system', mentions: [lead],
        text: `⏱ @${lead} ${mins} dakikadır hareket yok ve ${open.length} açık görev var. team_overview ile duruma bak; tıkananı dürt ya da görevi yeniden ata.` });
    }
  }

  /** Kim ne yapıyor: üyeler, görevleri, kilitleri, son mesajları. */
  teamOverview(roomId) {
    const ago = (ts) => { const s = (now() - ts) / 1000; return s < 90 ? 'az önce' : s < 3600 ? `${Math.round(s / 60)} dk önce` : `${Math.round(s / 3600)} sa önce`; };
    const P = { listening: 'hazır/dinliyor', working: 'çalışıyor', silent: 'sessiz', left: 'ayrıldı' };
    const lead = this.lead(roomId), tasks = this.tasks(roomId), locks = this.locks(roomId);
    const lines = [lead ? `👑 Koordinatör: ${lead}` : 'Koordinatör yok.', '', 'ÜYELER'];
    for (const a of this.roomAgents(roomId)) {
      const mine = tasks.filter((t) => t.assignee === a.name && t.status !== 'done').map((t) => `#${t.id} ${t.title} [${t.status}]`);
      const held = locks.filter((l) => l.owner === a.name).map((l) => l.path);
      const lastMsg = this.get('SELECT text, created_at FROM messages WHERE room_id=? AND from_name=? AND to_name IS NULL ORDER BY id DESC LIMIT 1', roomId, a.name);
      lines.push(`• ${a.name}${a.role ? ' — ' + a.role : ''} [${P[this.presence(a)]}]`
        + (a.status ? `\n    durum: ${a.status}` : '')
        + `\n    görev: ${mine.join('; ') || 'yok'}`
        + (held.length ? `\n    kilitli dosyalar: ${held.join(', ')}` : '')
        + (lastMsg ? `\n    son mesaj (${ago(lastMsg.created_at)}): ${lastMsg.text.replace(/\s+/g, ' ').slice(0, 160)}` : ''));
    }
    const by = (s) => tasks.filter((t) => t.status === s).length;
    lines.push('', `GÖREVLER: ${by('doing')} yapılıyor · ${by('review')} incelemede · ${by('blocked')} engelli · ${by('todo')} bekliyor · ${by('done')} bitti`);
    for (const t of tasks.filter((x) => x.status !== 'done')) lines.push(`  #${t.id} [${t.status}] ${t.title} — ${t.assignee || 'sahipsiz'}${t.notes.length ? ` · son not: ${t.notes[t.notes.length - 1].text.slice(0, 100)}` : ''}`);
    const notes = this.notes(roomId).map((n) => n.key);
    if (notes.length) lines.push('', `ORTAK NOTLAR: ${notes.join(', ')}`);
    return lines.join('\n');
  }

  // --- görevler
  taskRow(t) { return t && { ...t, notes: JSON.parse(t.notes) }; }
  task(roomId, id) { return this.taskRow(this.get('SELECT * FROM tasks WHERE id=? AND room_id=?', Number(id), roomId)) || fail(`Görev #${id} bu odada yok.`); }
  tasks(roomId) { return this.all('SELECT * FROM tasks WHERE room_id=? ORDER BY id', roomId).map((t) => this.taskRow(t)); }
  resolveAssignee(roomId, name) {
    if (name == null || name === '') return null;
    const n = cleanName(name);
    if (lower(n) === lower(this.human)) return this.human;
    const a = this.agentByName(n);
    if (!a) fail(`"${name}" adlı ajan yok.`);
    return a.name;
  }
  taskCreate(roomId, by, { title, description = '', assignee = null }) {
    title = String(title || '').trim().slice(0, 200);
    if (!title) fail('Görev başlığı boş olamaz.');
    const who = this.resolveAssignee(roomId, assignee);
    const r = this.run('INSERT INTO tasks(room_id,title,description,assignee,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      roomId, title, String(description).slice(0, 5000), who, by, now(), now());
    const id = Number(r.lastInsertRowid);
    this.post({ roomId, from: 'sistem', fromKind: 'system', quiet: true, mentions: who && who !== by ? [who] : [],
      text: `📋 ${by} görev #${id} oluşturdu: ${title}${who ? ` → atanan: @${who}` : ' (sahipsiz — task_claim ile alınabilir)'}` });
    return this.task(roomId, id);
  }
  taskUpdate(roomId, by, id, { status, assignee, note, title, description }) {
    const t = this.task(roomId, id);
    if (status != null && !TASK_STATUSES.includes(status)) fail(`Geçersiz durum. Geçerli: ${TASK_STATUSES.join(', ')}`);
    const who = assignee !== undefined ? this.resolveAssignee(roomId, assignee) : t.assignee;
    const notes = note ? [...t.notes, { by, ts: now(), text: String(note).slice(0, 2000) }] : t.notes;
    this.run('UPDATE tasks SET status=?, assignee=?, notes=?, title=?, description=?, updated_at=? WHERE id=?',
      status ?? t.status, who, JSON.stringify(notes), title != null ? String(title).slice(0, 200) : t.title,
      description != null ? String(description).slice(0, 5000) : t.description, now(), t.id);
    const bits = [];
    if (status && status !== t.status) bits.push(`durum: ${t.status} → ${status}`);
    if (who !== t.assignee) bits.push(who ? `atanan: @${who}` : 'atama kaldırıldı');
    if (note) bits.push(`not: ${String(note).slice(0, 300)}`);
    if (bits.length) {
      const wake = new Set();
      if (who && who !== by && who !== t.assignee) wake.add(who);
      if (status && status !== t.status && ['done', 'blocked', 'review'].includes(status)) {
        if (t.created_by !== by) wake.add(t.created_by);
        const lead = this.lead(roomId);
        if (lead && lead !== by) wake.add(lead);
      }
      this.post({ roomId, from: 'sistem', fromKind: 'system', quiet: true, mentions: [...wake],
        text: `📋 ${by} görev #${t.id} (${t.title}) güncelledi — ${bits.join('; ')}` });
    } else this.changed();
    return this.task(roomId, id);
  }
  taskClaim(roomId, by, id) {
    const t = this.task(roomId, id);
    if (t.assignee && t.assignee !== by && t.status !== 'done') fail(`Görev #${t.id} zaten ${t.assignee} üzerinde. Başka görev seç ya da onunla konuş.`);
    return this.taskUpdate(roomId, by, id, { assignee: by, status: 'doing' });
  }
  taskDelete(roomId, id) { this.run('DELETE FROM tasks WHERE id=? AND room_id=?', Number(id), roomId); this.changed(); }

  // --- ortak notlar
  notes(roomId) { return this.all('SELECT * FROM notes WHERE room_id=? ORDER BY key', roomId); }
  note(roomId, key) { return this.get('SELECT * FROM notes WHERE room_id=? AND key=?', roomId, String(key || '').trim()); }
  noteWrite(roomId, by, key, content, append = false) {
    key = String(key || '').trim().slice(0, 80);
    if (!key) fail('Not anahtarı boş olamaz.');
    const old = this.note(roomId, key);
    const text = append && old ? `${old.content}\n${content}` : String(content ?? '');
    if (text.length > 200000) fail('Not çok büyük (en fazla 200.000 karakter).');
    this.run('INSERT INTO notes(room_id,key,content,updated_by,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(room_id,key) DO UPDATE SET content=excluded.content, updated_by=excluded.updated_by, updated_at=excluded.updated_at',
      roomId, old?.key || key, text, by, now());
    this.post({ roomId, from: 'sistem', fromKind: 'system', quiet: true, mentions: [],
      text: `📝 ${by} "${old?.key || key}" notunu ${old ? (append ? 'genişletti' : 'güncelledi') : 'oluşturdu'}.` });
  }
  noteDelete(roomId, key) { this.run('DELETE FROM notes WHERE room_id=? AND key=?', roomId, key); this.changed(); }

  // --- dosya kilitleri (tavsiye niteliğinde)
  locks(roomId) { return this.all('SELECT * FROM locks WHERE room_id=? ORDER BY path', roomId); }
  lockAcquire(roomId, by, paths, note = '') {
    const want = [...new Set((Array.isArray(paths) ? paths : [paths]).map(normPath).filter(Boolean))];
    if (!want.length) fail('En az bir yol ver.');
    const held = this.locks(roomId);
    const conflicts = held.filter((l) => l.owner !== by && want.some((p) => pathsOverlap(p, l.path)));
    if (conflicts.length) fail(`Kilit alınamadı; şu yollar başkasında: ${conflicts.map((l) => `${l.path} (${l.owner}${l.note ? ': ' + l.note : ''})`).join(', ')}. Sahibiyle konuş ya da başka dosyada çalış.`);
    for (const p of want) this.run('INSERT INTO locks(room_id,path,owner,note,created_at) VALUES(?,?,?,?,?) ON CONFLICT(room_id,path) DO UPDATE SET note=excluded.note',
      roomId, p, by, String(note).slice(0, 200), now());
    this.changed();
    return want;
  }
  lockRelease(roomId, by, paths) {
    if (!paths || !paths.length) { const n = this.run('DELETE FROM locks WHERE room_id=? AND owner=?', roomId, by).changes; this.changed(); return Number(n); }
    let n = 0;
    for (const p of paths.map(normPath)) n += Number(this.run('DELETE FROM locks WHERE room_id=? AND path=? AND owner=?', roomId, p, by).changes);
    this.changed();
    return n;
  }
  lockForce(roomId, path) { this.run('DELETE FROM locks WHERE room_id=? AND path=?', roomId, path); this.changed(); }
}
