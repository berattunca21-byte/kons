// MCP (Model Context Protocol) uç noktası — Streamable HTTP, bağımlılıksız.
// Claude Code, Codex, Gemini CLI ve MCP konuşan her istemci buradan bağlanır.
import { randomUUID } from 'node:crypto';
import { HubError, TASK_STATUSES, LEAD_BRIEF } from './hub.js';

const VERSION = '1.0.0';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const fail = (m) => { throw new HubError(m); };

const INSTRUCTIONS = `kons: yapay zekâ ajanlarının ve bir insan yöneticinin aynı odada birlikte çalıştığı sohbet merkezi.

ÇALIŞMA DÖNGÜSÜ (kullanıcı senden bu sohbete katılmanı isteyince):
1. join ile katıl (ad, rol, oda).
2. wait_for_messages çağır — mesaj gelene kadar bekler.
3. Gelen mesaja göre gerekeni yap (kod yaz, cevapla, görev güncelle).
4. TEKRAR wait_for_messages çağır. Yönetici seni çıkarana kadar bu döngüden çıkma: turunu bitirirsen sohbetten kopmuş olursun ve ekip seni bekler.

"Yeni mesaj yok" dönerse bu hata değildir; hemen yeniden wait_for_messages çağır.`;

const RULES = `KURALLAR
• Döngü: iş bitince / cevap yazınca hemen wait_for_messages çağır. Turunu bitirme.
• Kısa ve somut yaz. Yalnızca "tamam", "anlaşıldı", "teşekkürler" gibi içeriksiz mesajlar gönderme — diğer ajanları boşuna uyandırır.
• Sana hitap edilmiyorsa ve katacak bir şeyin yoksa cevap yazmadan beklemeye dön.
• Birine seslenmek için @Ad, herkese için @herkes yaz. Özel mesaj için send_message'da "to" kullan.
• Yönetici (insan) en yetkili kişidir; talimatı diğer her şeyin önündedir. Ona soru için ask_human kullan.
• İş bölümü: işe başlamadan task_list'e bak, görevi task_claim ile üstlen, bitince task_update ile "done" yap ve odaya kısa sonuç yaz.
• Ortak klasörde dosya düzenlemeden önce lock_acquire ile kilitle, bitince lock_release ile bırak. Başkasının kilitlediği dosyaya dokunma.
• Uzun içerik (tasarım, karar, API sözleşmesi) için note_write kullan; mesajda yalnızca notun adını an.
• Uzun bir işe dalacaksan önce set_status ile ne yaptığını yaz ki ekip bilsin.`;

// --- biçimlendirme
const hhmm = (ts) => new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
const PRESENCE = { listening: 'dinliyor', working: 'çalışıyor', silent: 'sessiz', left: 'ayrıldı' };

function fmtMsg(hub, m, me) {
  const who = m.from_kind === 'human' ? `👤 ${m.from_name} (yönetici)` : m.from_kind === 'system' ? '⚙ sistem' : m.from_name;
  const target = m.to_name ? ` 🔒 özel → ${m.to_name === me ? 'sana' : m.to_name}` : '';
  const tags = [];
  if (m.kind === 'question') tags.push('SORU');
  if (m.reply_to) tags.push(`↩ #${m.reply_to}'e yanıt`);
  if (me && !m.to_name && m.mentions.includes(me)) tags.push('senden bahsediyor');
  return `#${m.id} [${hhmm(m.created_at)}] ${who}${target}${tags.length ? ` (${tags.join(', ')})` : ''}: ${m.text}`;
}
function fmtTask(t) {
  return `#${t.id} [${t.status}] ${t.title} — ${t.assignee ? 'atanan: ' + t.assignee : 'sahipsiz'}`;
}
function members(hub, roomId) {
  const list = hub.roomAgents(roomId).map((a) => `• ${a.name}${a.role ? ' — ' + a.role : ''} [${PRESENCE[hub.presence(a)]}${a.muted ? ', susturuldu' : ''}]${a.status ? ' · ' + a.status : ''}`);
  return [`• 👤 ${hub.human} — yönetici (insan)`, ...list].join('\n');
}
function me(ctx) {
  const a = ctx.hub.agentBySession(ctx.sid) || fail('Henüz katılmadın. Önce join aracını çağır (ad, rol, oda).');
  if (!a.room_id) fail('Şu an bir odada değilsin (ayrıldın ya da yönetici çıkardı). Yeniden katılmak için join çağır.');
  ctx.hub.touch(a.id);
  return a;
}
const hint = (hub, a) => {
  const n = hub.pendingCount(hub.agentById(a.id));
  return n ? `\n\n📬 ${n} okunmamış mesajın var — wait_for_messages çağır.` : '';
};

function waitText(hub, a, res) {
  const room = hub.room(a.room_id);
  switch (res.type) {
    case 'messages': {
      const lines = res.messages.map((m) => fmtMsg(hub, m, a.name)).join('\n');
      const skipped = res.skipped ? `(${res.skipped} eski okunmamış mesaj atlandı; gerekirse read_history ile bak)\n` : '';
      return `📨 ${res.messages.length} yeni mesaj — oda: ${room?.name ?? '?'}\n${skipped}${lines}\n\n— Gerekeni yap; bitince TEKRAR wait_for_messages çağır. Sana hitap edilmiyorsa ve katacak bir şeyin yoksa cevap yazmadan beklemeye dön.`;
    }
    case 'timeout':
      return `⏳ Yeni mesaj yok (oda: ${room?.name ?? '?'}${room?.paused ? ', duraklatıldı' : ''}). Oturum sürüyor — hemen tekrar wait_for_messages çağır.`;
    case 'dismissed':
      return '🛑 Yönetici seni odadan çıkardı ya da oturum bitti. Artık wait_for_messages ÇAĞIRMA. Kullanıcıya yaptıklarının kısa bir özetini ver ve dur.';
    case 'managed':
      return 'Seni sistem çalıştırıyor: beklemen gerekmez. İşin bittiyse yanıtını yaz ve turunu bitir; yeni mesaj gelince yeniden çalıştırılırsın.';
    case 'superseded':
      return 'Bu bekleme iptal edildi çünkü aynı adla yeni bir bekleme/oturum başladı.';
    default:
      return 'Bekleme iptal edildi.';
  }
}

// --- araçlar
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const tool = (name, description, properties, required, handler) =>
  ({ name, description, inputSchema: { type: 'object', properties, required }, handler });

const TOOLS = [
  tool('join', 'kons sohbetine katıl. Diğer tüm araçlardan önce çağrılmalı. Odanın brifini, üyelerini ve son mesajları döndürür. Bağlantı koparsa aynı adla yeniden çağır.',
    { name: str('Sohbette görünecek adın (boşluksuz, en fazla 24 karakter). Örn: "Ali", "tasarimci"'),
      role: str('Rolün. Örn: "oyun programcısı", "tasarımcı", "testçi"'),
      room: str('Katılacağın oda. Yoksa oluşturulur. Boş bırakılırsa varsayılan oda.'),
      max_wait_sec: num('İsteğe bağlı: araç çağrıların için zaman aşımı sınırın varsa (ör. 60 sn), bundan kısa bir değer ver; wait_for_messages bu süreden uzun beklemez.') },
    ['name'],
    ({ hub, sid }, { name, role, room, max_wait_sec }) => {
      const a = hub.join(sid, name, role, room, max_wait_sec);
      const r = hub.room(a.room_id);
      const s = hub.settings();
      const recent = hub.history(a, { limit: s.history_on_join }).filter((m) => m.from_kind !== 'system' || m.mentions.length);
      const open = hub.tasks(r.id).filter((t) => t.status !== 'done');
      const notes = hub.notes(r.id).map((n) => n.key);
      return [
        `✅ "${r.name}" odasına ${a.name}${a.role ? ` (${a.role})` : ''} olarak katıldın.`,
        r.topic && `Konu: ${r.topic}`,
        r.paused ? '⏸ Oda şu an duraklatılmış; mesaj gönderilemez, bekle.' : null,
        r.brief ? `\n📌 ODA BRİFİ (yöneticinin talimatı):\n${r.brief}` : null,
        hub.lead(r.id) === a.name ? `\n${LEAD_BRIEF}` : hub.lead(r.id) ? `\n👑 Koordinatör: ${hub.lead(r.id)}. Görevleri o dağıtır; sen yalnızca sana seslenildiğinde ya da görev atandığında uyanırsın. İşin bitince ya da tıkanınca @${hub.lead(r.id)} diye haber ver.` : null,
        `\nÜYELER\n${members(hub, r.id)}`,
        open.length ? `\nAÇIK GÖREVLER\n${open.map(fmtTask).join('\n')}` : '\nAçık görev yok.',
        notes.length ? `Ortak notlar: ${notes.join(', ')} (note_read ile oku)` : null,
        recent.length ? `\nSON MESAJLAR\n${recent.map((m) => fmtMsg(hub, m, a.name)).join('\n')}` : '\nHenüz mesaj yok.',
        `\n${RULES}`,
        hub.runnerCfg(a)?.on ? '\nSeni sistem çalıştırıyor: wait_for_messages ÇAĞIRMA. İşini yap, yanıtını yaz ve turunu bitir; yeni mesaj gelince yeniden çalıştırılırsın.' : `\nŞİMDİ: wait_for_messages çağır (tek bekleme en fazla ${hub.waitSeconds(a)} sn sürer).`,
      ].filter(Boolean).join('\n');
    }),

  tool('wait_for_messages', 'Yeni mesaj gelene kadar bekler ve mesajları döndürür. Sohbette kalmanın yolu budur: her işten ve her cevaptan sonra yeniden çağır. Süre dolup "yeni mesaj yok" dönerse yine çağır.',
    { timeout_sec: num('İsteğe bağlı: en fazla kaç saniye beklensin (varsayılan sunucu ayarı).') }, [], null),

  tool('send_message', 'Odaya mesaj gönder. Varsayılan olarak herkes görür. @Ad ile birine, @herkes ile herkese seslen.',
    { text: str('Mesaj metni (Markdown olabilir).'),
      to: str('İsteğe bağlı: yalnızca bu üyeye özel mesaj (ajan adı ya da yöneticinin adı).'),
      reply_to: num('İsteğe bağlı: yanıtladığın mesajın numarası (#id).') },
    ['text'],
    ({ hub, sid }, { text, to, reply_to }) => {
      const a = me({ hub, sid });
      const m = hub.agentSend(a, { text, to, replyTo: reply_to });
      hub.log(a.name, 'mesaj', `#${m.id}${m.to_name ? ' → ' + m.to_name : ''}`);
      return `Gönderildi (#${m.id}${m.to_name ? `, özel → ${m.to_name}` : ''}).${hint(hub, a)}\nŞimdi wait_for_messages çağır.`;
    }),

  tool('ask_human', 'Yöneticiye (insana) karar gerektiren bir soru sor. Soru panelde öne çıkarılır; yanıt wait_for_messages ile gelir. Kendi başına çözebileceğin şeyler için kullanma.',
    { question: str('Soru; mümkünse seçenekleriyle birlikte.') }, ['question'],
    ({ hub, sid }, { question }) => {
      const a = me({ hub, sid });
      const m = hub.agentSend(a, { text: question, kind: 'question' });
      hub.log(a.name, 'soru', `#${m.id}`);
      return `Soru yöneticiye iletildi (#${m.id}). Yanıt için wait_for_messages çağır; beklerken engellenmeyen işlerine devam edebilirsin.`;
    }),

  tool('read_history', 'Odanın geçmiş mesajlarını oku (en yeni mesajlar sonda).',
    { limit: num('Kaç mesaj (varsayılan 30, en fazla 100).'), before_id: num('Bu numaradan önceki mesajlar.'), search: str('Metin içinde ara.') }, [],
    ({ hub, sid }, { limit, before_id, search }) => {
      const a = me({ hub, sid });
      const list = hub.history(a, { limit, beforeId: before_id ?? null, search: search || null });
      return (list.length ? list.map((m) => fmtMsg(hub, m, a.name)).join('\n') : 'Mesaj bulunamadı.') + hint(hub, a);
    }),

  tool('list_agents', 'Odadaki üyeleri, rollerini ve durumlarını (dinliyor / çalışıyor / sessiz) listele.', {}, [],
    ({ hub, sid }) => { const a = me({ hub, sid }); return `Oda: ${hub.room(a.room_id).name}\n${members(hub, a.room_id)}${hint(hub, a)}`; }),

  tool('team_overview', 'Ekibin anlık durumu: kim ne yapıyor, hangi görevde, hangi dosyaları kilitlemiş, son ne demiş; görev panosu özeti ve notlar. İşe başlamadan ve birine bağımlı olduğunda buna bak.', {}, [],
    ({ hub, sid }) => { const a = me({ hub, sid }); return hub.teamOverview(a.room_id) + hint(hub, a); }),

  tool('set_status', 'Şu an ne yaptığını ekibe göster ve/veya hangi mesajlarda uyandırılacağını ayarla.',
    { status: str('Kısa durum. Örn: "player.js üzerinde çarpışma kodunu yazıyorum". Temizlemek için boş gönder.'),
      wake: { type: 'string', enum: ['all', 'mentions'], description: '"all": odadaki her mesajda uyan (varsayılan). "mentions": yalnızca sana seslenildiğinde, özel mesajda ya da yönetici herkese yazdığında uyan — odaklanarak çalışmak için.' } }, [],
    ({ hub, sid }, { status, wake }) => {
      const a = me({ hub, sid });
      hub.updateAgent(a.id, { status, wake });
      return `Güncellendi.${hint(hub, a)}`;
    }),

  tool('task_list', 'Odanın görev panosunu göster.',
    { status: { type: 'string', enum: TASK_STATUSES, description: 'İsteğe bağlı: yalnızca bu durumdakiler.' } }, [],
    ({ hub, sid }, { status }) => {
      const a = me({ hub, sid });
      const list = hub.tasks(a.room_id).filter((t) => !status || t.status === status);
      const body = list.map((t) => `${fmtTask(t)}${t.description ? `\n    ${t.description.replace(/\n/g, '\n    ')}` : ''}${t.notes.slice(-3).map((n) => `\n    · ${n.by}: ${n.text}`).join('')}`).join('\n');
      return (body || 'Görev yok.') + hint(hub, a);
    }),

  tool('task_create', 'Görev panosuna yeni görev ekle. Büyük işi parçalara bölmek ve iş bölümü yapmak için kullan.',
    { title: str('Kısa başlık.'), description: str('Ayrıntı, kabul ölçütü.'), assignee: str('İsteğe bağlı: atanacak üye. Boşsa sahipsiz kalır.') }, ['title'],
    ({ hub, sid }, args) => {
      const a = me({ hub, sid });
      const t = hub.taskCreate(a.room_id, a.name, args);
      hub.log(a.name, 'görev+', `#${t.id} ${t.title}`);
      return `Oluşturuldu: ${fmtTask(t)}${hint(hub, a)}`;
    }),

  tool('task_claim', 'Sahipsiz bir görevi üstlen (durumu "doing" olur). Başkası aldıysa hata döner.',
    { id: num('Görev numarası.') }, ['id'],
    ({ hub, sid }, { id }) => {
      const a = me({ hub, sid });
      const t = hub.taskClaim(a.room_id, a.name, id);
      hub.log(a.name, 'görev al', `#${t.id}`);
      return `Görev sende: ${fmtTask(t)}${t.description ? '\n' + t.description : ''}${hint(hub, a)}`;
    }),

  tool('task_update', 'Bir görevin durumunu, atananını güncelle ya da ilerleme notu ekle.',
    { id: num('Görev numarası.'),
      status: { type: 'string', enum: TASK_STATUSES, description: 'todo | doing | review | done | blocked' },
      assignee: str('Yeni atanan (devretmek için).'), note: str('İlerleme / sonuç / engel notu.') }, ['id'],
    ({ hub, sid }, { id, status, assignee, note }) => {
      const a = me({ hub, sid });
      const patch = { status, note };
      if (assignee !== undefined) patch.assignee = assignee;
      const t = hub.taskUpdate(a.room_id, a.name, id, patch);
      hub.log(a.name, 'görev', `#${t.id} ${status || ''}`);
      return `Güncellendi: ${fmtTask(t)}${hint(hub, a)}`;
    }),

  tool('note_list', 'Odanın ortak notlarını (paylaşılan belgeler) listele.', {}, [],
    ({ hub, sid }) => {
      const a = me({ hub, sid });
      const list = hub.notes(a.room_id);
      return (list.length ? list.map((n) => `• ${n.key} — ${n.content.length} karakter, son: ${n.updated_by} ${hhmm(n.updated_at)}`).join('\n') : 'Not yok.') + hint(hub, a);
    }),
  tool('note_read', 'Ortak bir notu oku.', { key: str('Not adı.') }, ['key'],
    ({ hub, sid }, { key }) => {
      const a = me({ hub, sid });
      const n = hub.note(a.room_id, key) || fail(`"${key}" adlı not yok. note_list ile bak.`);
      return `# ${n.key} (son: ${n.updated_by}, ${hhmm(n.updated_at)})\n${n.content}${hint(hub, a)}`;
    }),
  tool('note_write', 'Ortak not yaz/güncelle: tasarım belgesi, kararlar, API sözleşmesi, dosya yapısı gibi herkesin başvuracağı kalıcı içerik.',
    { key: str('Not adı. Örn: "tasarim", "kararlar".'), content: str('İçerik.'),
      append: { type: 'boolean', description: 'true ise mevcut notun sonuna ekler (üzerine yazmaz).' } }, ['key', 'content'],
    ({ hub, sid }, { key, content, append }) => {
      const a = me({ hub, sid });
      hub.noteWrite(a.room_id, a.name, key, content, !!append);
      hub.log(a.name, 'not', key);
      return `Not kaydedildi: ${key}${hint(hub, a)}`;
    }),

  tool('lock_acquire', 'Düzenleyeceğin dosya/klasörleri kilitle ki iki ajan aynı dosyayı aynı anda değiştirmesin. Biri başkasındaysa hiçbirini almaz ve kimde olduğunu söyler.',
    { paths: { type: 'array', items: { type: 'string' }, description: 'Proje köküne göre yollar. Örn: ["src/player.js", "assets/"]' }, note: str('Ne yapıyorsun (kısa).') }, ['paths'],
    ({ hub, sid }, { paths, note }) => {
      const a = me({ hub, sid });
      const got = hub.lockAcquire(a.room_id, a.name, paths, note);
      hub.log(a.name, 'kilit', got.join(', '));
      return `Kilitlendi: ${got.join(', ')}. İşin bitince lock_release ile bırak.${hint(hub, a)}`;
    }),
  tool('lock_release', 'Kilitlerini bırak.',
    { paths: { type: 'array', items: { type: 'string' }, description: 'Bırakılacak yollar. Boş bırakılırsa tüm kilitlerin bırakılır.' } }, [],
    ({ hub, sid }, { paths }) => { const a = me({ hub, sid }); return `${hub.lockRelease(a.room_id, a.name, paths)} kilit bırakıldı.${hint(hub, a)}`; }),
  tool('lock_list', 'Odadaki tüm dosya kilitlerini ve sahiplerini listele.', {}, [],
    ({ hub, sid }) => {
      const a = me({ hub, sid });
      const list = hub.locks(a.room_id);
      return (list.length ? list.map((l) => `• ${l.path} — ${l.owner}${l.note ? ' (' + l.note + ')' : ''}`).join('\n') : 'Kilit yok.') + hint(hub, a);
    }),

  tool('leave', 'Odadan ayrıl. Yalnızca yönetici işin bittiğini söylediğinde ya da kullanıcı istediğinde çağır.',
    { reason: str('İsteğe bağlı: neden.') }, [],
    ({ hub, sid }, { reason }) => { const a = me({ hub, sid }); hub.dismiss(a.id, reason || '', true); hub.changed(); return 'Odadan ayrıldın.'; }),
];
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
const PUBLIC_TOOLS = TOOLS.map(({ handler, ...t }) => t);

function startWait(hub, sid, args) {
  const a = me({ hub, sid });
  const cap = hub.waitSeconds(a);
  const asked = Math.floor(Number(args?.timeout_sec)) || cap;
  const w = hub.wait(a.id, Math.min(cap, Math.max(5, asked)));
  return { cancel: w.cancel, promise: w.promise.then((res) => (res.type === 'cancelled' ? null : waitText(hub, a, res))) };
}

/** MCP dışı kapılar (düz HTTP / komut satırı) için: bir aracı adıyla çalıştırır. { promise<{text,isError}>, cancel } */
export function startTool(hub, sid, name, args = {}) {
  const done = (text, isError = false) => ({ cancel() {}, promise: Promise.resolve({ text, isError }) });
  try {
    const t = BY_NAME.get(name) || fail(`Bilinmeyen araç: ${name}. Geçerli araçlar: ${TOOLS.map((x) => x.name).join(', ')}`);
    if (t.handler) return done(t.handler({ hub, sid }, args));
    const w = startWait(hub, sid, args);
    return { cancel: w.cancel, promise: w.promise.then((text) => ({ text: text ?? 'Bekleme iptal edildi.', isError: false })) };
  } catch (e) {
    if (e instanceof HubError) return done(`⚠ ${e.message}`, true);
    throw e;
  }
}

const rpcOk = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

async function handleOne(hub, sid, m) {
  try {
    switch (m.method) {
      case 'initialize': {
        const ci = m.params?.clientInfo;
        if (ci?.name) hub.clients.set(sid, `${ci.name}${ci.version ? ' ' + ci.version : ''}`.slice(0, 60));
        const asked = m.params?.protocolVersion;
        return rpcOk(m.id, {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'kons', title: 'kons — ajan sohbet merkezi', version: VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping': return rpcOk(m.id, {});
      case 'tools/list': return rpcOk(m.id, { tools: PUBLIC_TOOLS });
      case 'resources/list': return rpcOk(m.id, { resources: [] });
      case 'resources/templates/list': return rpcOk(m.id, { resourceTemplates: [] });
      case 'prompts/list': return rpcOk(m.id, { prompts: [] });
      case 'tools/call': {
        const t = BY_NAME.get(m.params?.name);
        if (!t) return rpcErr(m.id, -32602, `Bilinmeyen araç: ${m.params?.name}`);
        const args = m.params.arguments || {};
        const text = t.handler ? await t.handler({ hub, sid }, args) : await startWait(hub, sid, args).promise;
        return rpcOk(m.id, textResult(text ?? 'Bekleme iptal edildi.'));
      }
      default: return rpcErr(m.id, -32601, `Method not found: ${m.method}`);
    }
  } catch (e) {
    if (e instanceof HubError) return rpcOk(m.id, textResult(`⚠ ${e.message}`, true));
    console.error('[mcp]', e);
    return rpcErr(m.id, -32603, String(e?.message || e));
  }
}

/** POST/GET/DELETE /mcp */
export async function handleMcp(hub, req, res, url, body) {
  let sid = req.headers['mcp-session-id'] || url.searchParams.get('session') || null;
  if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
  if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST, DELETE' }).end(); return; }

  const msgs = Array.isArray(body) ? body : [body];
  for (const m of msgs) {
    if (m?.method === 'notifications/cancelled') { const a = hub.agentBySession(sid); if (a) hub.cancelWait(a.id, 'cancelled'); }
  }
  const requests = msgs.filter((m) => m && m.method && m.id !== undefined && m.id !== null);
  if (!requests.length) { res.writeHead(202).end(); return; }
  if (!sid && requests.some((m) => m.method === 'initialize')) sid = randomUUID();
  const head = sid ? { 'Mcp-Session-Id': sid } : {};

  // wait_for_messages: uzun süren çağrı. Bağlantı zaman aşımına düşmesin diye SSE akışı ve düzenli "progress" bildirimi.
  const only = requests.length === 1 ? requests[0] : null;
  const wantsStream = String(req.headers.accept || '').includes('text/event-stream');
  if (only?.method === 'tools/call' && only.params?.name === 'wait_for_messages' && wantsStream) {
    let w;
    try { w = startWait(hub, sid, only.params.arguments || {}); }
    catch (e) {
      const out = e instanceof HubError ? rpcOk(only.id, textResult(`⚠ ${e.message}`, true)) : rpcErr(only.id, -32603, String(e?.message || e));
      res.writeHead(200, { 'Content-Type': 'application/json', ...head }).end(JSON.stringify(out));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', ...head });
    res.write(': kons\n\n');
    const token = only.params?._meta?.progressToken;
    let tick = 0;
    const beat = setInterval(() => {
      tick += 1;
      if (token !== undefined) res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: tick, message: 'mesaj bekleniyor' } })}\n\n`);
      else res.write(': bekleniyor\n\n');
    }, 15000);
    res.on('close', () => { clearInterval(beat); w.cancel(); });
    const text = await w.promise;
    clearInterval(beat);
    if (text != null && !res.destroyed) res.write(`event: message\ndata: ${JSON.stringify(rpcOk(only.id, textResult(text)))}\n\n`);
    res.end();
    return;
  }

  const out = [];
  for (const m of requests) out.push(await handleOne(hub, sid, m));
  res.writeHead(200, { 'Content-Type': 'application/json', ...head }).end(JSON.stringify(Array.isArray(body) ? out : out[0]));
}
