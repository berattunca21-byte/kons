#!/usr/bin/env node
// stdio ↔ HTTP köprüsü: yalnızca "komut çalıştıran" (stdio) MCP sunucularını destekleyen istemciler için.
// Kullanım (istemcinin MCP ayarında):  command: "node", args: ["<bu dosyanın tam yolu>"]
// İsteğe bağlı ortam değişkeni: KONS_URL (varsayılan http://127.0.0.1:4700/mcp)
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const URL_ = process.env.KONS_URL || 'http://127.0.0.1:4700/mcp';
const SID = randomUUID();
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

async function forward(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const hasId = msg && msg.id !== undefined && msg.id !== null;
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': SID },
      body: line,
    });
    if (res.status === 202 || !res.body) return;
    if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
      let buf = '';
      const dec = new TextDecoder();
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const ev = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = ev.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (data) process.stdout.write(data + '\n');
        }
      }
    } else {
      const text = await res.text();
      if (text) process.stdout.write(text.replace(/\n/g, ' ') + '\n');
    }
  } catch (e) {
    if (hasId) out({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `kons sunucusuna ulaşılamadı (${URL_}). Sunucu çalışıyor mu? ${e.message}` } });
  }
}

createInterface({ input: process.stdin }).on('line', (l) => { if (l.trim()) forward(l); }).on('close', () => setTimeout(() => process.exit(0), 200));
