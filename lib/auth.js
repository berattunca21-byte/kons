// Erişim denetimi.
//
// İki kip vardır:
//   YEREL (varsayılan)  : KONS_KEY yok. Sunucu yalnızca 127.0.0.1'i dinler, yalnızca yerel Host/Origin kabul eder.
//                         Bu bilgisayardaki kullanıcı yöneticidir; giriş yoktur.
//   PAYLAŞIMLI          : KONS_KEY ayarlı. Her insan anahtarla giriş yapar, her ajan anahtarla katılır.
//                         KONS_KEY yönetici anahtarıdır; isteğe bağlı KONS_GUEST_KEY misafir anahtarıdır
//                         (sohbet, görev, not; komut çalıştırma ve ayar yok).
// Sunucu, anahtar olmadan yerel olmayan bir adresi dinlemeyi reddeder.
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { cleanName } from './hub.js';

const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const RESERVED = ['sistem', 'system', 'herkes', 'all', 'everyone', 'hepiniz'];
const MIN_KEY = 16, MAX_FAILS = 8, LOCK_MS = 60000, MAX_SESSIONS = 500;

const digest = (s) => createHash('sha256').update(String(s)).digest();
const same = (a, b) => timingSafeEqual(digest(a), digest(b)); // uzunluk ve zamanlama sızdırmaz

export class Auth {
  constructor({ host, key, guestKey }) {
    this.key = key || '';
    this.guestKey = guestKey || '';
    this.shared = !!this.key;
    this.loopback = LOOPBACK.includes(host);
    this.sessions = new Map(); // çerez -> { role, name }
    this.fails = 0;
    this.lockedUntil = 0;
  }

  /** Güvensiz yapılandırmada açıklama döner; sunucu başlamamalıdır. */
  problem() {
    if (!this.loopback && !this.key) return 'GÜVENLİK: Sunucu yerel olmayan bir adresi (HOST) erişim anahtarı olmadan dinleyemez.\n'
      + 'Paneldeki "ajan başlat" bu bilgisayarda komut çalıştırır; anahtarsız açılırsa ağdaki herkes bunu yapabilir.\n'
      + `Bir yönetici anahtarı belirle (en az ${MIN_KEY} karakter):  KONS_KEY=uzun-rastgele-bir-anahtar`;
    if (this.key && this.key.length < MIN_KEY) return `GÜVENLİK: KONS_KEY en az ${MIN_KEY} karakter olmalı. Örnek üretmek için: node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`;
    if (this.guestKey && !this.key) return 'KONS_GUEST_KEY tek başına kullanılamaz; önce yönetici anahtarı KONS_KEY ayarlanmalı.';
    if (this.guestKey && this.guestKey.length < MIN_KEY) return `GÜVENLİK: KONS_GUEST_KEY en az ${MIN_KEY} karakter olmalı.`;
    if (this.guestKey && this.guestKey === this.key) return 'GÜVENLİK: KONS_GUEST_KEY, KONS_KEY ile aynı olamaz; aynı olursa misafirler yönetici olur.';
    return null;
  }

  /** Anahtarı doğrular: 'admin' | 'guest' | null. Deneme sınırı uygular; kilitliyken 'locked' döner. */
  check(key) {
    if (Date.now() < this.lockedUntil) return 'locked';
    const role = !key ? null : same(key, this.key) ? 'admin' : this.guestKey && same(key, this.guestKey) ? 'guest' : null;
    if (!role) {
      if (key && ++this.fails >= MAX_FAILS) { this.fails = 0; this.lockedUntil = Date.now() + LOCK_MS; }
      return null;
    }
    this.fails = 0;
    return role;
  }
  /** İstekteki anahtar. Ajan uçlarında Bearer başlığı ajan kimliğidir, anahtar değildir (bearer=false). */
  keyFrom(req, url, body, bearer = true) {
    const b = bearer ? /^Bearer\s+(\S+)/i.exec(req.headers.authorization || '')?.[1] : null;
    return req.headers['x-kons-key'] || body?.key || url.searchParams.get('key') || b || null;
  }
  /** Paylaşımlı kipte ajan/MCP isteği için: null (geçerli) ya da { code, text }. */
  denyAgent(req, url, body, bearer = true) {
    if (!this.shared) return null;
    const role = this.check(this.keyFrom(req, url, body, bearer));
    if (role === 'locked') return { code: 429, text: 'Çok fazla hatalı deneme. Bir dakika sonra yeniden dene.' };
    return role ? null : { code: 401, text: 'Bu sunucu erişim anahtarı istiyor. Anahtarı yöneticiden al; istemcide --key ANAHTAR (ya da KONS_KEY), HTTP\'de "x-kons-key" başlığıyla gönder.' };
  }

  /** CSRF ve DNS rebinding'e karşı: istek nereden geliyor? */
  originOk(req) {
    const host = req.headers.host || '';
    const origin = (req.headers.origin || '').replace(/^https?:\/\//, '');
    if (!this.shared) return LOCAL.test(host) && (!origin || LOCAL.test(origin));
    return !origin || origin === host || origin === req.headers['x-forwarded-host'];
  }

  cookie(req) { return /(?:^|;\s*)kons_s=([^;]+)/.exec(req.headers.cookie || '')?.[1] || null; }
  /** Panel kullanıcısı: { role, name } ya da null (giriş gerekli). */
  user(req) {
    if (!this.shared) return { role: 'admin', name: null };
    return this.sessions.get(this.cookie(req)) || null;
  }

  /** { code, body, cookie? } döner. */
  login(hub, req, { key, name }) {
    if (!this.shared) return { code: 200, body: { ok: true } };
    const role = this.check(key);
    if (role === 'locked') return { code: 429, body: { error: 'Çok fazla hatalı deneme. Bir dakika sonra yeniden dene.' } };
    if (!role) return { code: 401, body: { error: 'Anahtar yanlış.' } };
    let n = cleanName(name);
    if (!n && role === 'admin') n = hub.human;
    const low = n.toLocaleLowerCase('tr');
    if (!n) return { code: 400, body: { error: 'Sohbette görünecek adını yaz (boşluksuz).' } };
    if (RESERVED.includes(low)) return { code: 400, body: { error: `"${n}" adı ayrılmış; başka bir ad seç.` } };
    if (hub.agentByName(n)) return { code: 400, body: { error: `"${n}" adını bir ajan kullanıyor; başka bir ad seç.` } };
    if (role !== 'admin' && low === hub.human.toLocaleLowerCase('tr')) return { code: 400, body: { error: `"${n}" yöneticinin adı; başka bir ad seç.` } };
    if (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value);
    const sid = randomUUID();
    this.sessions.set(sid, { role, name: n });
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return { code: 200, body: { ok: true, role, name: n }, cookie: `kons_s=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}` };
  }
  logout(req) { this.sessions.delete(this.cookie(req)); return 'kons_s=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'; }
}
