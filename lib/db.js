import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS rooms(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '',
  brief TEXT NOT NULL DEFAULT '', paused INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agents(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', wake TEXT NOT NULL DEFAULT 'all',
  muted INTEGER NOT NULL DEFAULT 0, wait_sec INTEGER NOT NULL DEFAULT 0, room_id TEXT, cursor INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT 0, client TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY, agent_id INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, from_name TEXT NOT NULL,
  from_kind TEXT NOT NULL, to_name TEXT, kind TEXT NOT NULL DEFAULT 'chat', text TEXT NOT NULL,
  mentions TEXT NOT NULL DEFAULT '[]', reply_to INTEGER, quiet INTEGER NOT NULL DEFAULT 0,
  resolved INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_msg_room ON messages(room_id, id);
CREATE INDEX IF NOT EXISTS idx_msg_sender ON messages(room_id, from_kind, from_name);
CREATE INDEX IF NOT EXISTS idx_msg_open_q ON messages(room_id, id) WHERE kind='question' AND resolved=0;
CREATE TABLE IF NOT EXISTS tasks(
  id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo', assignee TEXT,
  created_by TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notes(
  room_id TEXT NOT NULL, key TEXT NOT NULL COLLATE NOCASE, content TEXT NOT NULL,
  updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(room_id, key));
CREATE TABLE IF NOT EXISTS locks(
  room_id TEXT NOT NULL, path TEXT NOT NULL COLLATE NOCASE, owner TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, PRIMARY KEY(room_id, path));
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, who TEXT NOT NULL,
  type TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export function openDb(dir) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'kons.db'));
  db.exec(SCHEMA);
  // sonradan eklenen sütunlar
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!cols('agents').includes('runner')) db.exec("ALTER TABLE agents ADD COLUMN runner TEXT NOT NULL DEFAULT ''");
  if (!cols('rooms').includes('lead')) db.exec('ALTER TABLE rooms ADD COLUMN lead TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_room ON tasks(room_id, status)');
  // Olay günlüğü sınırsız büyümesin: son 20000 olay kalır.
  db.exec('DELETE FROM events WHERE id <= (SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET 20000)');
  return db;
}
