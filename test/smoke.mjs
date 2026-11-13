// Uçtan uca duman testi: sahte MCP ajanlarıyla sunucuyu sınar.
// Önce sunucuyu başlat, sonra:  BASE=http://127.0.0.1:4799 node test/smoke.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:4700';
let passed = 0, failed = 0;
const check = (name, cond, extra = '') => { cond ? passed++ : failed++; console.log(`${cond ? '  ok ' : 'FAIL '} ${name}${cond ? '' : '\n      ' + String(extra).slice(0, 400)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Agent {
  id = 0; sid = null;
  async rpc(method, params) {
    const id = ++this.id;
    const r = await fetch(BASE + '/mcp', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(this.sid ? { 'Mcp-Session-Id': this.sid } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    this.sid = r.headers.get('mcp-session-id') || this.sid;
    const t = await r.text();
    if ((r.headers.get('content-type') || '').includes('event-stream')) {
      return t.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).find((x) => x.id === id);
    }
    return JSON.parse(t);
  }
  async init(client = 'smoke') { return this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: client, version: '1' } }); }
  async call(name, args = {}) { const r = await this.rpc('tools/call', { name, arguments: args }); return { text: r.result?.content?.[0]?.text ?? JSON.stringify(r), isError: !!r.result?.isError }; }
}
const admin = async (action, p = {}) => (await fetch(BASE + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...p }) })).json();
const state = async (room) => (await fetch(`${BASE}/api/state?room=${room}`)).json();

// Birikmiş mesajlar önce gelebilir: aranan metin gelene ya da 'mesaj yok' dönene kadar bekle.
const until = async (agent, needle, t = 8) => {
  let all = '';
  for (let i = 0; i < 6; i++) {
    const r = await agent.call('wait_for_messages', { timeout_sec: t });
    all += `${r.text} | `;
    if ((needle && r.text.includes(needle)) || !r.text.includes('yeni mesaj —')) break;
  }
  return { text: all };
};
const drain = (agent) => until(agent, null, 5);

const room = 'test-' + Date.now().toString(36);
const [ali, ayse, can] = [new Agent(), new Agent(), new Agent()];

const init = await ali.init(); await ayse.init(); await can.init('codex-cli');
check('initialize: sunucu bilgisi ve oturum', init.result?.serverInfo?.name === 'kons' && !!ali.sid, JSON.stringify(init));
const tools = await ali.rpc('tools/list', {});
check('tools/list: araçlar', tools.result?.tools?.length >= 17, tools.result?.tools?.length);

let r = await ali.call('send_message', { text: 'x' });
check('join öncesi araç reddedilir', r.isError && /join/.test(r.text), r.text);

r = await ali.call('join', { name: 'Ali', role: 'programcı', room });
check('join: Ali', !r.isError && r.text.includes('katıldın'), r.text);
await ayse.call('join', { name: 'Ayşe', role: 'tasarımcı', room });
r = await can.call('join', { name: 'Can', role: 'testçi', room });
check('join: Codex istemcisi kısa bekleme alır (50 sn)', r.text.includes('en fazla 50 sn'), r.text.slice(-200));
r = await new Agent().init().then(() => 0);
const dup = new Agent(); await dup.init();
r = await dup.call('join', { name: 'Yönetici', room });
check('ayrılmış ad reddedilir', r.isError, r.text);

// bekleme + teslim
let w = ali.call('wait_for_messages');
await sleep(200);
check('durum: Ali dinliyor', (await state(room)).agents.find((a) => a.name === 'Ali')?.presence === 'listening');
await ayse.call('send_message', { text: 'Merhaba @Ali, oyun fikri: uzay gemisi.' });
r = await w;
check('wait: mesaj teslim edildi', r.text.includes('uzay gemisi') && r.text.includes('senden bahsediyor'), r.text);
r = await ayse.call('wait_for_messages', { timeout_sec: 5 });
check('wait: kendi mesajını almaz, zaman aşımı döner', r.text.includes('Yeni mesaj yok'), r.text);

// özel mesaj
await drain(can);
w = until(can, 'gizli not');
const w2 = ayse.call('wait_for_messages', { timeout_sec: 5 });
await sleep(150);
await ali.call('send_message', { text: 'gizli not', to: 'Can' });
r = await w;
check('özel mesaj hedefe ulaşır', r.text.includes('gizli not') && r.text.includes('özel'), r.text);
r = await w2;
check('özel mesajı başkası görmez', !r.text.includes('gizli not'), r.text);

// odak kipi: yalnızca bahsedilince uyan
await ayse.call('set_status', { status: 'çizim yapıyorum', wake: 'mentions' });
w = ayse.call('wait_for_messages', { timeout_sec: 5 });
await sleep(150);
await sleep(1100);
await ali.call('send_message', { text: 'Genel bir yorum, kimseye değil.' });
r = await w;
check('odak kipi: genel mesaj uyandırmaz', r.text.includes('Yeni mesaj yok'), r.text);
w = ayse.call('wait_for_messages', { timeout_sec: 8 });
await sleep(150);
await admin('send', { room, text: 'Herkese: oyunun adı Yıldız Avcısı olsun.' });
r = await w;
check('yönetici mesajı odak kipindekini de uyandırır + birikenleri getirir', r.text.includes('Yıldız Avcısı') && r.text.includes('Genel bir yorum'), r.text);

// görevler
r = await ali.call('task_create', { title: 'Oyuncu hareketi', description: 'WASD ile hareket' });
const tid = Number(/#(\d+)/.exec(r.text)?.[1]);
check('görev oluşturuldu', tid > 0, r.text);
r = await ali.call('task_claim', { id: tid });
check('görev üstlenildi', r.text.includes('sende'), r.text);
r = await can.call('task_claim', { id: tid });
check('başkasının görevi alınamaz', r.isError && r.text.includes('Ali'), r.text);
r = await ali.call('task_update', { id: tid, status: 'done', note: 'bitti' });
check('görev tamamlandı', r.text.includes('[done]'), r.text);

// notlar
await ali.call('note_write', { key: 'tasarim', content: 'Satır 1' });
await can.call('note_write', { key: 'tasarim', content: 'Satır 2', append: true });
r = await ayse.call('note_read', { key: 'tasarim' });
check('not: yaz + ekle + oku', r.text.includes('Satır 1') && r.text.includes('Satır 2'), r.text);

// kilitler
r = await ali.call('lock_acquire', { paths: ['src/player.js', 'assets/'], note: 'hareket' });
check('kilit alındı', !r.isError, r.text);
r = await can.call('lock_acquire', { paths: ['assets/ship.png'] });
check('kilitli klasörün altı alınamaz', r.isError && r.text.includes('Ali'), r.text);
r = await ali.call('lock_release', {});
check('kilitler bırakıldı', r.text.startsWith('2 kilit'), r.text);

// soru
r = await can.call('ask_human', { question: 'Mobil destek olsun mu?' });
const qid = Number(/#(\d+)/.exec(r.text)?.[1]);
let st = await state(room);
check('soru panelde açık görünür', st.questions.some((q) => q.id === qid));
await drain(can);
w = until(can, 'Evet, olsun');
await sleep(150);
await admin('send', { room, text: 'Evet, olsun.', replyTo: qid });
r = await w;
st = await state(room);
check('yanıt soran ajanı uyandırır ve soruyu kapatır', r.text.includes('Evet, olsun') && !st.questions.length, r.text);

// duraklatma / susturma
await admin('room_pause', { room, paused: true });
r = await ali.call('send_message', { text: 'duraklatılmışken' });
check('duraklatılmış odada mesaj reddedilir', r.isError && r.text.includes('duraklatıldı'), r.text);
await drain(ali);
w = until(ali, 'devam ediyor');
await sleep(150);
await admin('room_pause', { room, paused: false });
r = await w;
check('devam bildirimi ajanı uyandırır', r.text.includes('devam ediyor'), r.text);
const canId = st.agents.find((a) => a.name === 'Can').id;
await admin('agent_update', { id: canId, muted: true });
r = await can.call('send_message', { text: 'susturulmuşken' });
check('susturulan ajan yazamaz', r.isError && r.text.includes('susturdu'), r.text);

// kopma sonrası aynı adla geri dönüş (yeni oturum)
const ali2 = new Agent(); await ali2.init();
r = await ali2.call('join', { name: 'ali', room });
check('aynı adla yeni oturum kimliği devralır', !r.isError && (await state(room)).agents.filter((a) => a.name.toLowerCase() === 'ali').length === 1, r.text);

// çıkarma
await drain(ayse);
w = until(ayse, 'ÇAĞIRMA');
await sleep(150);
await admin('dismiss_all', { room });
r = await w;
check('oturumu bitir: bekleyen ajan "dur" talimatı alır', r.text.includes('ÇAĞIRMA'), r.text);
r = await ayse.call('send_message', { text: 'x' });
check('çıkarılan ajan yeniden join etmeden yazamaz', r.isError, r.text);

// dışa aktarım + temizlik
const md = await (await fetch(`${BASE}/api/export?room=${room}`)).text();
check('dışa aktarım', md.includes('Yıldız Avcısı') && md.includes('Not: tasarim'), md.slice(0, 200));
if (!process.env.KEEP) {
  for (const a of (await state(room)).agents.filter((x) => ['Ali', 'Ayşe', 'Can'].includes(x.name))) await admin('agent_delete', { id: a.id });
  await admin('room_delete', { room });
}

console.log(`\n${passed} geçti, ${failed} kaldı`);
process.exit(failed ? 1 : 0);
