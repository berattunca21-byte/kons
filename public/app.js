/* kons paneli — bağımlılıksız, tek dosya. */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* yok say */ } } };

const S = { room: store.get('kons.room'), tab: store.get('kons.tab') || 'agents', st: null, dm: null, reply: null, sig: '', sigRoom: null, older: [], log: [], client: 'any' };
const TABS = [['agents', 'Ajanlar'], ['tasks', 'Görevler'], ['notes', 'Notlar'], ['locks', 'Kilitler'], ['log', 'Günlük']];
const STATUS = { todo: 'yapılacak', doing: 'yapılıyor', review: 'incelemede', done: 'bitti', blocked: 'engelli' };
const PRES = { listening: 'dinliyor', working: 'çalışıyor', silent: 'sessiz', left: 'ayrıldı' };

// --- yardımcılar
const time = (ts) => new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
const ago = (ts) => { const s = Math.max(0, (Date.now() - ts) / 1000); return s < 60 ? `${Math.floor(s)} sn` : s < 3600 ? `${Math.floor(s / 60)} dk` : `${Math.floor(s / 3600)} sa`; };
const color = (name) => { let h = 0; for (const c of String(name)) h = (h * 31 + c.codePointAt(0)) % 360; return `hsl(${h} 62% 62%)`; };
function rich(t) {
  const blocks = [];
  let h = esc(t).replace(/\n?```[\w-]*\n?([\s\S]*?)\n?```\n?/g, (_, c) => { blocks.push(c); return `\u0001${blocks.length - 1}\u0001`; });
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])@([\p{L}\p{N}_.-]+)/gu, '$1<span class="mention">@$2</span>');
  return h.replace(/\u0001(\d+)\u0001/g, (_, i) => `<pre>${blocks[i]}</pre>`);
}
let toastTimer;
function toast(msg, good = false) {
  const t = $('#toast'); t.textContent = msg; t.className = good ? 'good' : ''; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, good ? 1800 : 5000);
}
async function act(action, payload = {}) {
  try {
    const r = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, room: S.room, ...payload }) });
    const j = await r.json();
    if (r.status === 401) { loginDialog(); return null; }
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  } catch (e) { toast(e.message); return null; }
}
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Kopyalandı', true); } catch { toast('Kopyalanamadı; metni elle seç.'); } }

// --- veri
let loading = false, again = false;
async function load() {
  if (loading) { again = true; return; }
  loading = true;
  try {
    const r = await fetch('/api/state?room=' + encodeURIComponent(S.room || ''));
    if (r.status === 401) { loading = false; return loginDialog(); }
    S.st = await r.json();
    document.body.classList.toggle('guest', S.st.me.role !== 'admin');
    if (!es || es.readyState === 2) listen(); // girişten önce reddedilen akış kendiliğinden yeniden bağlanmaz
    if (S.room !== S.st.room.id) { S.room = S.st.room.id; store.set('kons.room', S.room); }
    if (S.tab === 'log') S.log = await (await fetch('/api/log')).json();
    render();
  } catch { /* bağlantı göstergesi zaten kırmızıya döner */ }
  loading = false;
  if (again) { again = false; load(); }
}
let es = null;
function listen() {
  es?.close();
  es = new EventSource('/api/events');
  es.onopen = () => $('#conn').classList.add('ok');
  es.onmessage = () => load();
  es.onerror = () => $('#conn').classList.remove('ok');
}
// Paylaşımlı kipte giriş: anahtar + sohbette görünecek ad.
function loginDialog() {
  if (S.locked) return;
  S.locked = true;
  dialog('kons — giriş', '<div class="help">Bu sunucu erişim anahtarı istiyor. Anahtarı sunucuyu çalıştıran kişiden al.</div>'
    + field('Erişim anahtarı', 'key', '', 'type="password" required autocomplete="current-password"') + field('Sohbette görünecek adın', 'name', store.get('kons.name') || '', 'required maxlength="24" autocomplete="nickname"'),
  async (v) => {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) });
    const j = await r.json();
    if (!r.ok) { toast(j.error || 'Giriş başarısız.'); return false; }
    store.set('kons.name', j.name); S.locked = false; load();
  }, 'Giriş');
  $('#dlgform [data-close]')?.remove();
}
async function logout() { await fetch('/api/logout', { method: 'POST' }); location.reload(); }
const roomAgents = () => S.st.agents.filter((a) => a.room_id === S.room);

// --- çizim
function render() {
  const st = S.st;
  document.title = `${st.room.name} — kons`;
  $('#rooms').innerHTML = st.rooms.map((r) => `<button class="room ${r.id === S.room ? 'sel' : ''}" data-act="room" data-id="${esc(r.id)}">
    <span class="n">${r.paused ? '⏸ ' : '# '}${esc(r.name)}</span>
    ${r.questions ? `<span class="badge q" title="Yanıt bekleyen soru">${r.questions}</span>` : ''}
    <span class="badge" title="Dinleyen / toplam ajan">${r.listening}/${r.agents}</span></button>`).join('');
  renderHead(); renderMessages(); renderQuestions(); renderChips(); renderTabs();
}
function renderHead() {
  const r = S.st.room, ag = roomAgents();
  const n = (p) => ag.filter((a) => a.presence === p).length;
  $('#head').innerHTML = `<h1># ${esc(r.name)}</h1><span class="topic" title="${esc(r.topic)}">${esc(r.topic) || '<i>konu yok</i>'}</span>
    <span class="stat">${r.lead ? `👑 ${esc(r.lead)} · ` : ''}🟢 ${n('listening')} hazır · 🟡 ${n('working')} çalışıyor${n('silent') ? ` · 🔴 ${n('silent')} sessiz` : ''}</span>
    <button data-act="pause" class="${r.paused ? 'on' : ''}" title="Duraklatınca ajanlar mesaj gönderemez">${r.paused ? '▶ Devam ettir' : '⏸ Duraklat'}</button>
    <button class="adm" data-act="room-edit" title="Konu ve ajanlara verilen talimat">📌 Brif</button>
    <button class="adm" data-act="room-menu">⋯</button>${S.st.me.shared ? `<button data-act="logout" title="Çıkış yap">👤 ${esc(S.st.me.name)}${S.st.me.role === 'admin' ? '' : ' (misafir)'} ⎋</button>` : ''}`
    + (r.paused ? '<div class="paused-bar" style="flex-basis:100%;margin:6px -16px -10px">Oda duraklatıldı — ajanlar bekliyor, yalnızca sen yazabilirsin.</div>' : '');
}
function msgHtml(m, byName) {
  if (m.from_kind === 'system') return `<div class="msg sys" data-id="${m.id}"><span class="t">${time(m.created_at)}</span> ${rich(m.text)}</div>`;
  const human = m.from_kind === 'human';
  const a = byName[m.from_name];
  const orig = m.reply_to ? S.byId[m.reply_to] : null;
  return `<div class="msg ${human ? 'human' : ''} ${m.kind === 'question' ? 'question' : ''} ${m.resolved ? 'resolved' : ''} ${m.to_name ? 'dm' : ''}" data-id="${m.id}">
    <div class="av" style="background:${human ? 'var(--accent)' : color(m.from_name)}">${human ? '👤' : esc([...m.from_name][0].toLocaleUpperCase('tr'))}</div>
    <div class="body"><div class="meta"><b>${esc(m.from_name)}</b><span class="role">${human ? (m.from_name === S.st.settings.human_name ? 'yönetici' : 'insan') : esc(a?.role || '')}</span>
      ${m.to_name ? `<span class="tag dm">🔒 özel → ${esc(m.to_name)}</span>` : ''}
      ${m.kind === 'question' ? (m.resolved ? '<span class="tag ok">soru · yanıtlandı</span>' : '<span class="tag qn">SORU</span>') : ''}
      <span class="t">#${m.id} · ${time(m.created_at)}</span></div>
      ${m.reply_to ? `<div class="quote">↩ #${m.reply_to}${orig ? ` ${esc(orig.from_name)}: ${esc(orig.text.slice(0, 120))}` : ''}</div>` : ''}
      <div class="text">${rich(m.text)}</div></div>
    <div class="acts"><button data-act="reply" data-id="${m.id}">yanıtla</button><button data-act="msg-del" data-id="${m.id}" class="danger">sil</button></div></div>`;
}
function renderMessages() {
  const box = $('#msgs');
  const list = [...S.older, ...S.st.messages];
  S.byId = Object.fromEntries(list.map((m) => [m.id, m]));
  const byName = Object.fromEntries(S.st.agents.map((a) => [a.name, a]));
  const sigs = list.map((m) => `${m.id}:${m.resolved}`);
  const sig = sigs.join(',');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (S.sigRoom === S.room && S.sig && sig.startsWith(S.sig) && sig !== S.sig) {
    const have = S.sig.split(',').length;
    box.insertAdjacentHTML('beforeend', list.slice(have).map((m) => msgHtml(m, byName)).join(''));
  } else if (S.sigRoom !== S.room || sig !== S.sig) {
    const more = S.st.hasMore && S.older.length % 200 === 0 && list.length ? '<button class="more ghost" data-act="older">Daha eski mesajları yükle</button>' : '';
    box.innerHTML = list.length ? more + list.map((m) => msgHtml(m, byName)).join('')
      : '<div class="empty">Henüz mesaj yok.<br>Soldaki <b>🔌 Ajan bağla</b> ile ajanlarını bu odaya çağır, sonra buradan görevi ver.</div>';
  }
  if (atBottom || S.sigRoom !== S.room) box.scrollTop = box.scrollHeight;
  S.sig = sig; S.sigRoom = S.room;
}
function renderQuestions() {
  $('#questions').innerHTML = S.st.questions.map((q) => `<div class="qrow"><span>❓ <b>${esc(q.from_name)}</b> soruyor: ${esc(q.text)}</span>
    <button class="primary" data-act="reply" data-id="${q.id}">Yanıtla</button><button data-act="q-close" data-id="${q.id}">Kapat</button></div>`).join('');
}
function renderChips() {
  const c = [];
  if (S.dm) c.push(`<span class="chip"><span>🔒 Yalnızca <b>${esc(S.dm)}</b> görecek</span><button data-act="dm-clear" title="Kaldır">✕</button></span>`);
  if (S.reply) { const m = S.byId?.[S.reply]; c.push(`<span class="chip"><span>↩ #${S.reply}${m ? ` ${esc(m.from_name)}: ${esc(m.text.slice(0, 60))}` : ''}</span><button data-act="reply-clear" title="Kaldır">✕</button></span>`); }
  $('#chips').innerHTML = c.join('');
}
function renderTabs() {
  const open = S.st.tasks.filter((t) => t.status !== 'done').length;
  const counts = { agents: roomAgents().length, tasks: open, notes: S.st.notes.length, locks: S.st.locks.length };
  $('#tabs').innerHTML = TABS.map(([id, label]) => `<button role="tab" class="${S.tab === id ? 'sel' : ''}" data-act="tab" data-id="${id}">${label}${counts[id] ? ` <span class="badge">${counts[id]}</span>` : ''}</button>`).join('');
  if ($('#tab').contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return; // açık menüyü kapatma
  $('#tab').innerHTML = ({ agents: tabAgents, tasks: tabTasks, notes: tabNotes, locks: tabLocks, log: tabLog })[S.tab]();
}
const GUEST_ACTS = new Set(['at', 'dm']); // misafirin kartta görebildiği düğmeler
function agentCard(a) {
  const inRoom = a.room_id === S.room, r = a.runner, hasLead = !!S.st.room.lead, lead = inRoom && S.st.room.lead === a.name;
  const pres = a.running ? `çalışıyor · ${ago(a.working_since || Date.now())}` : r?.on && a.room_id ? 'hazır' : a.presence === 'working' && a.working_since ? `çalışıyor · ${ago(a.working_since)}` : a.presence === 'silent' ? `sessiz · ${ago(a.last_seen)}` : PRES[a.presence];
  const mine = S.st.tasks.filter((t) => t.assignee === a.name && t.status !== 'done');
  const held = S.st.locks.filter((l) => l.owner === a.name);
  const b = (act, label, cls = '', title = '') => `<button data-act="${act}" data-id="${a.id}" data-name="${esc(a.name)}" class="${cls} ${GUEST_ACTS.has(act) ? '' : 'adm'}" title="${title}">${label}</button>`;
  return `<div class="card ${lead ? 'lead' : ''}"><div class="top"><span class="dot ${a.presence}"></span><b>${lead ? '👑 ' : ''}${esc(a.name)}</b><span class="role">${esc(a.role)}</span><span class="pres">${pres}</span></div>
    ${a.status ? `<div class="sub">💬 ${esc(a.status)}</div>` : ''}
    ${mine.length ? `<div class="sub">📋 ${mine.map((t) => `#${t.id} ${esc(t.title)}`).join(' · ')}</div>` : ''}
    ${held.length ? `<div class="sub">🔐 ${held.map((l) => esc(l.path)).join(', ')}</div>` : ''}
    <div class="sub">${a.msgs} mesaj · ${r ? `⚙ sistem çalıştırıyor${r.on ? '' : ' (kapalı)'} · ${r.runs || 0} tur` : esc(a.client || 'elle bağlı')}${!inRoom && a.room_id ? ` · oda: ${esc(a.room_id)}` : ''}</div>
    ${a.pending && !a.running && !(r?.on) && a.presence !== 'listening' ? `<div class="sub warn">📬 ${a.pending} mesaj yanıt bekliyor</div>` : ''}
    ${a.presence === 'silent' && !r ? '<div class="sub warn">Uzun süredir araç çağırmadı; turunu bitirmiş olabilir. Kalıcı çözüm: <b>çalıştırıcı</b> ekle, sistem uyandırsın.</div>' : ''}
    <div class="btns">${a.room_id ? `${inRoom ? b('at', '@ seslen') + b('dm', '🔒 özel') : ''}
      ${r ? (a.running ? b('a-stop', '⏹ durdur', 'danger', 'Süren turu sonlandırır ve çalıştırıcıyı kapatır') : r.on ? b('a-run', '▶ şimdi çalıştır', '', 'Mesaj beklemeden bir tur başlatır') + b('a-off', '⏸ kapat', '', 'Kapalıyken ajan uyandırılmaz') : b('a-on', '▶ aç', 'on')) + b('a-out', 'çıktı', '', 'Son turun komutu, çıktısı ve hatası') : ''}
      ${inRoom ? b('a-lead', lead ? '👑 koordinatör' : 'koordinatör yap', lead ? 'on' : '', 'Koordinatör görevleri dağıtır ve odadaki her mesajı duyar; diğerleri yalnızca seslenilince uyanır') : ''}
      ${b('a-mute', a.muted ? '🔇 susturuldu' : 'sustur', a.muted ? 'on' : '', 'Susturulan ajan mesaj gönderemez')}
      ${hasLead ? '' : b('a-wake', a.wake === 'mentions' ? '🎯 odakta' : 'odak kipi', a.wake === 'mentions' ? 'on' : '', 'Odak kipinde ajan yalnızca kendisine seslenilince uyanır')}
      ${b('a-edit', 'düzenle')}${b('a-runner', r ? 'çalıştırıcı ayarı' : '+ çalıştırıcı', '', 'Ajanı sistemin başlatıp uyandırması için komut')}
      ${b('a-dismiss', 'çıkar', 'danger', 'Ajana durmasını söyler ve odadan çıkarır')}`
    : b('a-delete', 'kaydı sil', 'danger')}</div></div>`;
}
function tabAgents() {
  const here = roomAgents(), others = S.st.agents.filter((a) => a.room_id !== S.room);
  return `<div class="sec"><span>Bu odada (${here.length})</span><span><button class="mini adm" data-act="a-spawn" title="Ajanı kons başlatsın ve mesaj geldikçe uyandırsın">+ ajan başlat</button> ${here.length ? '<button class="mini danger adm" data-act="dismiss-all" title="Tüm ajanlara durmalarını söyler">oturumu bitir</button>' : ''}</span></div>`
    + (here.map(agentCard).join('') || '<div class="help">Bu odada ajan yok.<br><b>+ ajan başlat</b>: ajanı kons çalıştırır, mesaj geldikçe uyandırır (durma sorunu olmaz).<br><b>🔌 Ajan bağla</b>: kendi açtığın bir ajanı odaya çağırırsın.</div>')
    + (others.length ? `<div class="sec"><span>Diğer / ayrılmış (${others.length})</span></div>` + others.map(agentCard).join('') : '');
}
function tabTasks() {
  const order = ['doing', 'blocked', 'review', 'todo', 'done'];
  const names = [S.st.settings.human_name, ...roomAgents().map((a) => a.name)];
  const tasks = [...S.st.tasks].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.id - b.id);
  return '<div class="sec"><span>Görev panosu</span><button class="mini" data-act="t-new">+ görev</button></div>'
    + (tasks.map((t) => `<div class="card"><div class="top"><b title="${esc(t.title)}">#${t.id} ${esc(t.title)}</b><span class="st ${t.status}" style="margin-left:auto">${STATUS[t.status]}</span></div>
      ${t.description ? `<div class="sub">${esc(t.description)}</div>` : ''}
      ${t.notes.slice(-2).map((n) => `<div class="sub">· <b>${esc(n.by)}</b>: ${esc(n.text)}</div>`).join('')}
      <div class="btns"><select data-change="t-assign" data-id="${t.id}" title="Atanan"><option value="">sahipsiz</option>${[...new Set([...names, t.assignee].filter(Boolean))].map((n) => `<option ${t.assignee === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
      <select data-change="t-status" data-id="${t.id}" title="Durum">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${t.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <button data-act="t-del" data-id="${t.id}" class="danger">sil</button></div></div>`).join('')
      || '<div class="help">Görev yok. Ajanlar işi kendileri de bölüp buraya yazabilir; sen de ekleyip atayabilirsin.</div>');
}
function tabNotes() {
  return '<div class="sec"><span>Ortak notlar</span><button class="mini" data-act="n-new">+ not</button></div>'
    + (S.st.notes.map((n) => `<div class="card"><div class="top"><b>📝 ${esc(n.key)}</b><span class="pres">${esc(n.updated_by)} · ${time(n.updated_at)}</span></div>
      <div class="sub">${esc(n.content.slice(0, 160))}${n.content.length > 160 ? '…' : ''}</div>
      <div class="btns"><button data-act="n-open" data-key="${esc(n.key)}">aç / düzenle</button><button data-act="n-del" data-key="${esc(n.key)}" class="danger">sil</button></div></div>`).join('')
      || '<div class="help">Not yok. Ajanlar tasarım belgesi, kararlar, dosya yapısı gibi kalıcı içeriği buraya yazar.</div>');
}
function tabLocks() {
  return '<div class="sec"><span>Dosya kilitleri</span></div>'
    + (S.st.locks.map((l) => `<div class="card"><div class="top"><b title="${esc(l.path)}">🔐 ${esc(l.path)}</b><span class="pres">${esc(l.owner)} · ${ago(l.created_at)}</span></div>
      ${l.note ? `<div class="sub">${esc(l.note)}</div>` : ''}<div class="btns"><button data-act="l-del" data-path="${esc(l.path)}" class="danger">kilidi kaldır</button></div></div>`).join('')
      || '<div class="help">Kilit yok. Ajanlar aynı dosyayı aynı anda değiştirmemek için düzenlemeden önce dosyayı kilitler.</div>');
}
function tabLog() {
  return '<div class="sec"><span>Olay günlüğü (son 200)</span></div>'
    + (S.log.map((e) => `<div class="logrow"><span class="t">${time(e.ts)}</span> <b>${esc(e.who)}</b> ${esc(e.type)} <span class="role">${esc(e.detail)}</span></div>`).join('') || '<div class="help">Henüz olay yok.</div>');
}

// --- pencereler
function dialog(title, body, onOk, okLabel = 'Kaydet') {
  const f = $('#dlgform');
  f.innerHTML = `<h2>${esc(title)}</h2>${body}<div class="foot"><button type="button" data-close>${onOk ? 'Vazgeç' : 'Kapat'}</button>${onOk ? `<button class="primary" type="submit">${esc(okLabel)}</button>` : ''}</div>`;
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (!onOk) return $('#dlg').close();
    if (await onOk(Object.fromEntries(new FormData(f))) !== false) $('#dlg').close();
  };
  $('#dlg').showModal();
  f.querySelector('input,textarea,select')?.focus();
}
const field = (label, name, value = '', attrs = '') => `<label>${label}<input name="${name}" value="${esc(value)}" ${attrs}></label>`;
const area = (label, name, value = '', attrs = '') => `<label>${label}<textarea name="${name}" ${attrs}>${esc(value)}</textarea></label>`;
const copyBox = (text) => `<div class="copy"><pre>${esc(text)}</pre><button type="button" data-copy="${esc(text)}">kopyala</button></div>`;

function connectDialog() {
  const url = location.origin + '/mcp';
  const bridge = S.st.bridge || 'bridge.mjs';
  const sep = (S.st.root || '').includes('\\') ? '\\' : '/';
  const guide = `${S.st.root || '.'}${sep}AGENTS.md`;
  const C = {
    any: ['Her ajan (komutla)', `<div class="help">Kurulum yok. Komut çalıştırabilen her ajan (Devin, Codex, Gemini, OpenCode, Claude Code, DeepSeek…) talimat dosyasını okuyup katılır. Ajan başka bir bilgisayardaysa bu yol çalışmaz.</div>`],
    claude: ['Claude Code', `<div class="step">1 · Bir kez: sunucuyu tanıt</div>${copyBox(`claude mcp add --transport http --scope user kons ${url}`)}
      <div class="step">2 · Ajanı başlat (kons araçları için tek tek izin sormasın)</div>${copyBox('claude --allowedTools "mcp__kons"')}`],
    codex: ['Codex', `<div class="step">1 · Bir kez: <code>~/.codex/config.toml</code> dosyasına ekle</div>${copyBox(`[mcp_servers.kons]\nurl = "${url}"\ntool_timeout_sec = 300`)}
      <div class="help">Codex'in araç zaman aşımı varsayılan olarak kısadır; kons bu yüzden Codex ajanlarını 50 sn'lik beklemelerle dinletir. <code>tool_timeout_sec</code> yükselttiysen ajan kartındaki <b>düzenle</b>'den bekleme süresini artırabilirsin. Sürümün <code>url</code> desteklemiyorsa "Diğer (stdio)" sekmesindeki köprüyü kullan.</div>`],
    gemini: ['Gemini CLI', `<div class="step">1 · Bir kez: <code>~/.gemini/settings.json</code> dosyasına ekle</div>${copyBox(JSON.stringify({ mcpServers: { kons: { httpUrl: url, timeout: 600000, trust: true } } }, null, 2))}
      <div class="help"><code>trust: true</code> kons araçları için onay sorulmasını kapatır; istemiyorsan çıkar.</div>`],
    opencode: ['OpenCode', `<div class="step">1 · Bir kez: <code>opencode.json</code> dosyasına ekle (proje klasöründe ya da <code>~/.config/opencode/</code> altında)</div>${copyBox(JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { kons: { type: 'remote', url, enabled: true } } }, null, 2))}
      <div class="help">Bağlanmazsa yerel komut biçimini dene: <code>"type": "local", "command": ["node", "${esc(bridge.replace(/\\/g, '\\\\'))}"]</code></div>`],
    other: ['Diğer (stdio)', `<div class="step">1 · MCP konuşan her istemci: yerel komut olarak ekle</div>${copyBox(JSON.stringify({ mcpServers: { kons: { command: 'node', args: [bridge] } } }, null, 2))}
      <div class="help">Köprü, stdio üzerinden gelen çağrıları bu sunucuya aktarır. HTTP destekleyen istemcilerde doğrudan şu adresi de kullanabilirsin: <code>${esc(url)}</code></div>`],
  };
  const draw = (v = {}) => {
    const name = (v.name ?? 'Ali').trim() || 'Ali', role = (v.role ?? 'programcı').trim(), room = v.room ?? S.room;
    const remote = S.st.me.shared ? ` Sunucu: ${location.origin} (join komutuna --server ile ver); erişim anahtarını sana ayrıca vereceğim (--key).` : '';
    const prompt = S.client === 'any'
      ? `kons sohbetine katıl: "${guide}" dosyasındaki talimatları izle. Adın "${name}"${role ? `, rolün "${role}"` : ''}, oda "${room}". Katıldıktan sonra odayı dinle, gelen mesajlara göre çalış ve yönetici seni çıkarana kadar sohbette kal; turunu bitirme.` + remote
      : `kons sohbetine katıl: kons MCP sunucusunun join aracını name="${name}"${role ? `, role="${role}"` : ''}, room="${room}" ile çağır. Ardından wait_for_messages ile odayı dinle, gelen mesajlara göre çalış ve her işten sonra yeniden wait_for_messages çağır. Yönetici seni çıkarana kadar bu döngüden çıkma, turunu bitirme.`;
    return `<div class="seg">${Object.entries(C).map(([k, [label]]) => `<button type="button" data-client="${k}" class="${S.client === k ? 'on' : ''}">${label}</button>`).join('')}</div>
      ${C[S.client][1]}
      <div class="step">${S.client === 'claude' ? 3 : S.client === 'any' ? 1 : 2} · Ajana şunu söyle (her ajan için ad ve rolü değiştir)</div>
      <div class="grid2">${field('Ad', 'name', name, 'data-live')}${field('Rol', 'role', role, 'data-live')}</div>
      ${field('Oda', 'room', room, 'data-live')}
      <div id="prompt">${copyBox(prompt)}</div>`;
  };
  dialog('Ajan bağla', draw(), null);
  const f = $('#dlgform');
  const redraw = (keepFocus) => {
    const v = Object.fromEntries(new FormData(f));
    if (keepFocus) { const tmp = document.createElement('div'); tmp.innerHTML = draw(v); $('#prompt').innerHTML = tmp.querySelector('#prompt').innerHTML; return; }
    const foot = f.querySelector('.foot').outerHTML;
    f.innerHTML = `<h2>Ajan bağla</h2>${draw(v)}${foot}`;
  };
  f.oninput = (e) => { if (e.target.matches('[data-live]')) redraw(true); };
  f.onclick = (e) => { const b = e.target.closest('[data-client]'); if (b) { S.client = b.dataset.client; redraw(false); } };
}

const RUNNERS = {
  claude: ['Claude Code', 'claude -p --session-id {session} --permission-mode acceptEdits --allowedTools "mcp__kons"', 'claude -p --resume {session} --permission-mode acceptEdits --allowedTools "mcp__kons"',
    'Bu bilgisayarda denendi. Bu hâliyle dosya okuyup düzenleyebilir ve kons araçlarını kullanabilir; kabuk komutu (derleme, test) çalıştıramaz. İzin vermek istersen tırnak içine Bash ekle: --allowedTools "mcp__kons Bash".'],
  codex: ['Codex', 'codex exec --skip-git-repo-check -', '', 'Denenmedi; komutu kendi Codex sürümüne göre düzelt. İstem stdin\'den verilir.'],
  gemini: ['Gemini CLI', 'gemini', '', 'Denenmedi; komutu kendi sürümüne göre düzelt. İstem stdin\'den verilir.'],
  opencode: ['OpenCode', 'opencode run "Read the file {prompt_file} and follow its instructions exactly."', '', 'Denenmedi; komutu kendi sürümüne göre düzelt.'],
  custom: ['Başka bir ajan', '', '', 'Komut satırından tek seferlik çalışabilen her ajan olur (Devin, DeepSeek, yerel model…).'],
};
const runnerFields = (r = {}, preset = 'claude') => `<div class="seg">${Object.entries(RUNNERS).map(([k, [label]]) => `<button type="button" data-preset="${k}">${label}</button>`).join('')}</div>
  <div class="help" id="preset-note">${r.start ? '' : RUNNERS[preset][3]}</div>
  ${field('Çalıştırma komutu (ilk tur)', 'start', r.start ?? RUNNERS[preset][1], 'required spellcheck="false"')}
  ${field('Devam komutu (sonraki turlar; boşsa ilk komut kullanılır)', 'resume', r.resume ?? RUNNERS[preset][2], 'spellcheck="false"')}
  ${field('Çalışma klasörü (ajanın proje klasörü)', 'cwd', r.cwd ?? '', 'spellcheck="false" placeholder="ör. C:\\Users\\…\\oyun"')}
  <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="post" style="width:auto" ${r.post === false ? '' : 'checked'}> Komutun çıktısını ajanın mesajı olarak odaya yaz</label>
  <div class="help">Her turda kons, ajana bekleyen mesajları ve ekip durumunu içeren istemi <b>stdin</b>'den verir; komut bitince çıktısı odaya yazılır.
  Yer tutucular: <code>{session}</code> ajan başına sabit kimlik (konuşmayı sürdürmek için) · <code>{prompt_file}</code> istemin yazıldığı dosya (stdin okumayan ajanlar için) · <code>{name}</code>.
  Ajanın neye izinli olduğunu bu komuttaki bayraklar belirler; komut senin kullanıcı hesabınla çalışır.</div>`;
function bindPresets() {
  $('#dlgform').onclick = (e) => {
    const p = e.target.closest('[data-preset]'); if (!p) return;
    const [, start, resume, note] = RUNNERS[p.dataset.preset];
    $('#dlgform [name=start]').value = start; $('#dlgform [name=resume]').value = resume; $('#preset-note').textContent = note;
  };
}
const agentOf = (d) => S.st.agents.find((x) => x.id == d.id);

// --- eylemler
const A = {
  room: (d) => { S.room = d.id; store.set('kons.room', S.room); S.older = []; S.dm = S.reply = null; load(); },
  tab: (d) => { S.tab = d.id; store.set('kons.tab', S.tab); load(); },
  send, connect: connectDialog, logout,
  older: async () => {
    const first = [...S.older, ...S.st.messages][0];
    const list = await (await fetch(`/api/messages?room=${encodeURIComponent(S.room)}&before=${first.id}`)).json();
    if (!list.length) return toast('Daha eski mesaj yok.', true);
    S.older = [...list, ...S.older]; S.sig = ''; renderMessages();
  },
  'room-new': () => dialog('Yeni oda', field('Oda adı', 'name', '', 'required placeholder="ör. oyun"') + field('Konu', 'topic', '', 'placeholder="ör. Birlikte bir tarayıcı oyunu yapıyoruz"')
    + area('Brif — bu odaya katılan her ajana verilen talimat (isteğe bağlı)', 'brief', '', 'placeholder="Hedef, proje klasörü, teknoloji, kurallar…"'),
  async (v) => { const r = await act('room_create', v); if (!r) return false; A.room({ id: r.room }); }, 'Oluştur'),
  'room-edit': () => { const r = S.st.room; dialog(`# ${r.name} — konu ve brif`, field('Oda adı', 'name', r.name) + field('Konu', 'topic', r.topic)
    + area('Brif — katılan her ajana gösterilir; değiştirince odadaki ajanlara da bildirilir', 'brief', r.brief, 'style="min-height:220px" placeholder="Hedef: …\nProje klasörü: C:\\\\…\nTeknoloji: …\nKurallar: …"'),
  async (v) => !!(await act('room_update', v))); },
  'room-menu': () => dialog(`# ${S.st.room.name}`, `<div class="seg"><a href="/api/export?room=${encodeURIComponent(S.room)}"><button type="button">⬇ Sohbeti indir (Markdown)</button></a>
    <a href="/api/export?room=${encodeURIComponent(S.room)}&format=json"><button type="button">⬇ JSON</button></a></div>
    <div class="seg"><button type="button" class="danger" data-act="room-clear">Mesajları temizle</button><button type="button" class="danger" data-act="room-del">Odayı sil</button></div>`, null),
  'room-clear': async () => { if (confirm('Bu odadaki tüm mesajlar kalıcı olarak silinsin mi?')) { await act('room_clear'); S.older = []; $('#dlg').close(); } },
  'room-del': async () => { if (confirm(`"${S.st.room.name}" odası; mesajları, görevleri, notları ve kilitleriyle birlikte kalıcı olarak silinsin mi?`)) { if (await act('room_delete')) { S.room = null; S.older = []; $('#dlg').close(); load(); } } },
  pause: () => act('room_pause', { paused: !S.st.room.paused }),
  'dismiss-all': () => { if (confirm('Bu odadaki tüm ajanlara durmaları söylensin ve odadan çıkarılsınlar mı?')) act('dismiss_all'); },
  settings: () => { const s = S.st.settings; dialog('Ayarlar', field('Sohbetteki adın', 'human_name', s.human_name)
    + `<div class="grid2">${field('Tek bekleme süresi (sn)', 'wait_timeout_sec', s.wait_timeout_sec, 'type="number" min="10" max="3600"')}${field('Mesajlar arası en kısa süre (sn)', 'min_interval_sec', s.min_interval_sec, 'type="number" min="0"')}
    ${field('Otomatik fren: sen yazmadan kaç ajan mesajında odayı duraklat (0 = kapalı)', 'auto_pause_after', s.auto_pause_after, 'type="number" min="0"')}${field('Katılan ajana gösterilen son mesaj', 'history_on_join', s.history_on_join, 'type="number" min="0" max="100"')}
    ${field('Çalıştırıcı: tek tur en fazla (dk)', 'run_timeout_min', s.run_timeout_min, 'type="number" min="1"')}${field('Koordinatörü dürt: açık görev varken sessizlik (dk, 0 = kapalı)', 'nudge_idle_min', s.nudge_idle_min, 'type="number" min="0"')}</div>
    <div class="help">Bekleme süresi: ajan bu kadar saniye mesaj gelmezse "mesaj yok" yanıtını alıp yeniden dinlemeye geçer. Otomatik fren, ajanların kendi aralarında sonsuza dek konuşup kota tüketmesine karşı sigortadır.</div>`,
  async (v) => !!(await act('settings_update', { settings: v }))); },

  reply: (d) => { S.reply = Number(d.id); const m = S.byId[S.reply]; if (m?.to_name && m.from_kind === 'agent') S.dm = m.from_name; renderChips(); $('#input').focus(); },
  'reply-clear': () => { S.reply = null; renderChips(); },
  'dm-clear': () => { S.dm = null; renderChips(); },
  'msg-del': (d) => act('message_delete', { id: d.id }),
  'q-close': (d) => act('question_resolve', { id: d.id }),
  at: (d) => { const i = $('#input'); i.value += (i.value && !/\s$/.test(i.value) ? ' ' : '') + '@' + d.name + ' '; i.focus(); },
  dm: (d) => { S.dm = d.name; renderChips(); $('#input').focus(); },
  'a-mute': (d) => { const a = S.st.agents.find((x) => x.id == d.id); act('agent_update', { id: a.id, muted: !a.muted }); },
  'a-wake': (d) => { const a = S.st.agents.find((x) => x.id == d.id); act('agent_update', { id: a.id, wake: a.wake === 'all' ? 'mentions' : 'all' }); },
  'a-edit': (d) => { const a = S.st.agents.find((x) => x.id == d.id); dialog(`${a.name} — düzenle`, field('Rol', 'role', a.role)
    + field(`Tek bekleme süresi (sn) — 0: genel ayar (${S.st.settings.wait_timeout_sec} sn). İstemcinin araç zaman aşımından kısa olmalı.`, 'wait_sec', a.wait_sec, 'type="number" min="0" max="3600"'),
  async (v) => !!(await act('agent_update', { id: a.id, ...v }))); },
  'a-dismiss': (d) => act('agent_dismiss', { id: d.id }),
  'a-spawn': () => { dialog('Ajan başlat — kons çalıştırsın', `<div class="grid2">${field('Ad', 'name', '', 'required placeholder="ör. Ali"')}${field('Rol', 'role', '', 'placeholder="ör. oyun programcısı"')}</div>` + runnerFields(),
    async (v) => !!(await act('agent_spawn', { ...v, post: !!v.post })), 'Başlat'); bindPresets(); },
  'a-runner': (d) => { const a = agentOf(d); dialog(`${a.name} — çalıştırıcı`, runnerFields(a.runner || {}),
    async (v) => !!(await act('agent_runner', { id: a.id, ...v, post: !!v.post, on: true })), a.runner ? 'Kaydet' : 'Ekle ve aç'); bindPresets(); },
  'a-run': (d) => { const a = agentOf(d); dialog(`${a.name} — şimdi çalıştır`, area('Bu tur için talimat (isteğe bağlı)', 'prompt', '', 'placeholder="Boş bırakırsan: duruma bak ve gerekeni yap."'),
    async (v) => !!(await act('agent_run', { id: a.id, ...v })), 'Çalıştır'); },
  'a-stop': (d) => act('agent_stop', { id: d.id }),
  'a-off': (d) => act('agent_runner', { id: d.id, on: false }),
  'a-on': (d) => act('agent_runner', { id: d.id, on: true }),
  'a-lead': (d) => act('room_lead', { name: S.st.room.lead === d.name ? '' : d.name }),
  'a-out': async (d) => {
    const a = agentOf(d), i = await (await fetch('/api/run?id=' + a.id)).json();
    if (!i.cmd) return toast('Bu ajan henüz hiç çalıştırılmadı.', true);
    const dur = Math.round(((i.endedAt || Date.now()) - i.startedAt) / 1000);
    dialog(`${a.name} — son tur`, `<div class="help">${i.running ? '🟡 sürüyor' : i.code === 0 ? '🟢 başarılı' : `🔴 çıkış kodu ${i.code}`} · ${time(i.startedAt)} · ${dur} sn</div>
      <label>Komut<pre>${esc(i.cmd)}</pre></label><label>Çıktı (odaya yazılan)<pre>${esc(i.out) || '—'}</pre></label>
      ${i.err ? `<label>Hata çıktısı<pre>${esc(i.err)}</pre></label>` : ''}<details><summary class="help">Ajana verilen istem</summary><pre>${esc(i.prompt)}</pre></details>`, null);
  },
  'a-delete': (d) => { if (confirm('Bu ajanın kaydı silinsin mi?')) act('agent_delete', { id: d.id }); },
  't-new': () => dialog('Yeni görev', field('Başlık', 'title', '', 'required') + area('Açıklama / kabul ölçütü', 'description')
    + `<label>Atanan<select name="assignee"><option value="">sahipsiz (ajanlar kendileri alır)</option>${roomAgents().map((a) => `<option>${esc(a.name)}</option>`).join('')}</select></label>`,
  async (v) => !!(await act('task_create', v)), 'Ekle'),
  't-del': (d) => { if (confirm('Görev silinsin mi?')) act('task_delete', { id: d.id }); },
  'n-new': () => dialog('Yeni not', field('Not adı', 'key', '', 'required placeholder="ör. tasarim"') + area('İçerik', 'content', '', 'style="min-height:260px"'), async (v) => !!(await act('note_write', v))),
  'n-open': (d) => { const n = S.st.notes.find((x) => x.key === d.key); dialog(`📝 ${n.key}`, `<input type="hidden" name="key" value="${esc(n.key)}">` + area(`Son düzenleyen: ${esc(n.updated_by)}`, 'content', n.content, 'style="min-height:340px"'), async (v) => !!(await act('note_write', v))); },
  'n-del': (d) => { if (confirm(`"${d.key}" notu silinsin mi?`)) act('note_delete', { key: d.key }); },
  'l-del': (d) => act('lock_release', { path: d.path }),
};
const CHANGE = {
  't-assign': (d, v) => act('task_update', { id: d.id, assignee: v }),
  't-status': (d, v) => act('task_update', { id: d.id, status: v }),
};

async function send() {
  const i = $('#input');
  const text = i.value.trim();
  if (!text) return;
  const r = await act('send', { text, to: S.dm, replyTo: S.reply });
  if (!r) return;
  i.value = ''; S.reply = null; autosize(); renderChips();
  $('#msgs').scrollTop = $('#msgs').scrollHeight;
}
function autosize() { const i = $('#input'); i.style.height = 'auto'; i.style.height = Math.min(180, i.scrollHeight + 2) + 'px'; }

// --- @ önerileri
let sug = [], sugIdx = 0;
function suggest() {
  const i = $('#input'), box = $('#suggest');
  const m = /(^|\s)@([\p{L}\p{N}_.-]*)$/u.exec(i.value.slice(0, i.selectionStart));
  sug = m ? ['herkes', ...roomAgents().map((a) => a.name)].filter((n) => n.toLocaleLowerCase('tr').startsWith(m[2].toLocaleLowerCase('tr'))) : [];
  sugIdx = Math.min(sugIdx, Math.max(0, sug.length - 1));
  box.hidden = !sug.length;
  box.innerHTML = sug.map((n, k) => `<button type="button" class="${k === sugIdx ? 'sel' : ''}" data-sug="${esc(n)}">@${esc(n)}</button>`).join('');
}
function pick(name) {
  const i = $('#input'), pos = i.selectionStart;
  const before = i.value.slice(0, pos).replace(/@[\p{L}\p{N}_.-]*$/u, '@' + name + ' ');
  i.value = before + i.value.slice(pos); i.selectionStart = i.selectionEnd = before.length;
  sug = []; $('#suggest').hidden = true; i.focus();
}

// --- olaylar
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-copy]'); if (c) return copy(c.dataset.copy);
  if (e.target.closest('[data-close]')) return $('#dlg').close();
  const s = e.target.closest('[data-sug]'); if (s) return pick(s.dataset.sug);
  const b = e.target.closest('[data-act]'); if (b && A[b.dataset.act]) A[b.dataset.act](b.dataset);
});
document.addEventListener('change', (e) => { const k = e.target.dataset?.change; if (k) { CHANGE[k](e.target.dataset, e.target.value); e.target.blur(); } });
$('#input').addEventListener('input', () => { autosize(); suggest(); });
$('#input').addEventListener('keydown', (e) => {
  if (sug.length && !$('#suggest').hidden) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sugIdx = (sugIdx + (e.key === 'ArrowDown' ? 1 : sug.length - 1)) % sug.length; return suggest(); }
    if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); return pick(sug[sugIdx]); }
    if (e.key === 'Escape') { sug = []; $('#suggest').hidden = true; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
$('#dlg').addEventListener('cancel', (e) => { if (S.locked) e.preventDefault(); }); // giriş penceresi Esc ile kapanmasın
setInterval(() => { if (S.st && !$('#dlg').open) renderTabs(); }, 15000); // "3 dk önce" gibi süreler güncel kalsın
load(); // canlı akış ilk başarılı yüklemede açılır
