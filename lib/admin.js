// Tarayıcı paneli için: durum özeti ve yönetici eylemleri.
import { HubError } from './hub.js';

const PAGE = 200;

export function buildState(hub, roomId) {
  const rooms = hub.all('SELECT * FROM rooms ORDER BY created_at');
  const room = rooms.find((r) => r.id === roomId) || rooms[0];
  const agents = hub.all('SELECT * FROM agents ORDER BY name').map((a) => hub.agentView(a));
  const counts = Object.fromEntries(hub.all('SELECT from_name n, COUNT(*) c FROM messages WHERE room_id=? AND from_kind=? GROUP BY from_name', room.id, 'agent').map((r) => [r.n, r.c]));
  for (const a of agents) { a.msgs = counts[a.name] || 0; a.wait_effective = hub.waitSeconds(a); }
  const messages = hub.all('SELECT * FROM (SELECT * FROM messages WHERE room_id=? ORDER BY id DESC LIMIT ?) ORDER BY id', room.id, PAGE).map((r) => hub.row(r));
  const total = hub.get('SELECT COUNT(*) c FROM messages WHERE room_id=?', room.id).c;
  return {
    settings: hub.settings(),
    rooms: rooms.map((r) => {
      const inRoom = agents.filter((a) => a.room_id === r.id);
      return { ...r, agents: inRoom.length, listening: inRoom.filter((a) => a.presence === 'listening').length,
        questions: hub.get("SELECT COUNT(*) c FROM messages WHERE room_id=? AND kind='question' AND resolved=0", r.id).c };
    }),
    room,
    agents,
    messages,
    hasMore: total > messages.length,
    tasks: hub.tasks(room.id),
    notes: hub.notes(room.id),
    locks: hub.locks(room.id),
    questions: hub.all("SELECT * FROM messages WHERE room_id=? AND kind='question' AND resolved=0 ORDER BY id", room.id).map((r) => hub.row(r)),
  };
}

export function olderMessages(hub, roomId, beforeId) {
  return hub.all('SELECT * FROM (SELECT * FROM messages WHERE room_id=? AND id<? ORDER BY id DESC LIMIT ?) ORDER BY id', roomId, Number(beforeId), PAGE).map((r) => hub.row(r));
}

export function exportRoom(hub, roomId, format) {
  const room = hub.requireRoom(roomId);
  const messages = hub.all('SELECT * FROM messages WHERE room_id=? ORDER BY id', roomId).map((r) => hub.row(r));
  const tasks = hub.tasks(roomId);
  const notes = hub.notes(roomId);
  if (format === 'json') return JSON.stringify({ room, messages, tasks, notes }, null, 2);
  const t = (ts) => new Date(ts).toLocaleString('tr-TR');
  const out = [`# ${room.name}`, room.topic && `> ${room.topic}`, room.brief && `\n## Brif\n${room.brief}`, '\n## Sohbet'];
  for (const m of messages) {
    const who = m.from_kind === 'human' ? `👤 ${m.from_name}` : m.from_kind === 'guest' ? `👤 ${m.from_name} (misafir)` : m.from_kind === 'system' ? '⚙ sistem' : m.from_name;
    out.push(`**${who}**${m.to_name ? ` → 🔒 ${m.to_name}` : ''} · #${m.id} · ${t(m.created_at)}${m.reply_to ? ` · ↩ #${m.reply_to}` : ''}\n\n${m.text}\n`);
  }
  if (tasks.length) out.push('## Görevler', ...tasks.map((x) => `- [${x.status === 'done' ? 'x' : ' '}] #${x.id} ${x.title} — ${x.status}${x.assignee ? ', ' + x.assignee : ''}`));
  for (const n of notes) out.push(`\n## Not: ${n.key}\n${n.content}`);
  return out.filter(Boolean).join('\n');
}

const need = (v, what) => { if (v === undefined || v === null || v === '') throw new HubError(`${what} gerekli.`); return v; };

const ACTIONS = {
  send: (hub, p, runner, by, user) => { hub.humanSend(need(p.room, 'room'), p, by, user?.role === 'admin' ? 'human' : 'guest'); },
  message_delete: (hub, p) => { hub.run('DELETE FROM messages WHERE id=?', Number(p.id)); hub.changed(); },
  question_resolve: (hub, p) => { hub.run('UPDATE messages SET resolved=1 WHERE id=?', Number(p.id)); hub.changed(); },

  room_create: (hub, p) => ({ room: hub.createRoom(need(p.name, 'Oda adı'), p.topic || '', p.brief || '') }),
  room_update: (hub, p) => hub.updateRoom(need(p.room, 'room'), p),
  room_pause: (hub, p) => hub.setPaused(need(p.room, 'room'), !!p.paused),
  room_clear: (hub, p) => hub.clearRoom(need(p.room, 'room')),
  room_delete: (hub, p) => hub.deleteRoom(need(p.room, 'room')),
  dismiss_all: (hub, p, runner) => { for (const a of hub.roomAgents(need(p.room, 'room'))) { runner.stop(a.id); hub.dismiss(a.id, 'yönetici oturumu bitirdi'); } hub.changed(); },

  agent_update: (hub, p) => hub.updateAgent(Number(need(p.id, 'id')), p),
  agent_dismiss: (hub, p, runner) => { runner.stop(Number(need(p.id, 'id'))); hub.dismiss(Number(p.id), 'yönetici çıkardı'); hub.changed(); },
  agent_delete: (hub, p, runner) => { runner.stop(Number(need(p.id, 'id'))); hub.deleteAgent(Number(p.id)); },

  // çalıştırıcı
  agent_spawn: (hub, p, runner) => { runner.spawnAgent({ ...p, name: need(p.name, 'Ad'), room: need(p.room, 'room'), start: need(p.start, 'Çalıştırma komutu') }); },
  agent_runner: (hub, p, runner) => { runner.configure(Number(need(p.id, 'id')), p); },
  agent_run: (hub, p, runner) => { runner.maybeRun(Number(need(p.id, 'id')), String(p.prompt || '').trim() || 'Duruma bak ve gerekeni yap.'); },
  agent_stop: (hub, p, runner) => { runner.stop(Number(need(p.id, 'id'))); },
  room_lead: (hub, p) => hub.setLead(need(p.room, 'room'), p.name || null),

  task_create: (hub, p, runner, by) => { hub.taskCreate(need(p.room, 'room'), by, p); },
  task_update: (hub, p, runner, by) => {
    const patch = { status: p.status, note: p.note, title: p.title, description: p.description };
    if ('assignee' in p) patch.assignee = p.assignee;
    hub.taskUpdate(need(p.room, 'room'), by, need(p.id, 'id'), patch);
  },
  task_delete: (hub, p) => hub.taskDelete(need(p.room, 'room'), need(p.id, 'id')),

  note_write: (hub, p, runner, by) => hub.noteWrite(need(p.room, 'room'), by, need(p.key, 'Not adı'), p.content || ''),
  note_delete: (hub, p) => hub.noteDelete(need(p.room, 'room'), need(p.key, 'key')),
  lock_release: (hub, p) => hub.lockForce(need(p.room, 'room'), need(p.path, 'path')),

  settings_update: (hub, p) => hub.setSettings(p.settings),
};

// Misafirin yapabildikleri. Listede olmayan her şey (ajan başlatma/komut, ayarlar, silme, brif, koordinatör…) yönetici ister.
// Misafir silme yapamaz (README ile aynı); yalnızca sohbet, görev ve not ekleme/güncelleme.
const GUEST_OK = new Set(['send', 'question_resolve', 'task_create', 'task_update', 'note_write', 'room_pause']);

export function runAction(hub, body, runner, user = { role: 'admin', name: null }) {
  const fn = ACTIONS[body?.action];
  if (!fn) throw new HubError(`Bilinmeyen eylem: ${body?.action}`);
  if (user.role !== 'admin' && !GUEST_OK.has(body.action)) throw new HubError('Bu işlem için yönetici yetkisi gerekir.');
  const by = user.name || hub.human;
  const out = fn(hub, body, runner, by, user) || {};
  if (!['send', 'settings_update'].includes(body.action)) hub.log(by, body.action, JSON.stringify({ ...body, action: undefined, content: undefined, brief: undefined, start: undefined, resume: undefined, prompt: undefined }).slice(0, 200));
  return out;
}
