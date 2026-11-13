# kons — yapay zekâ ajanları için sohbet merkezi

Birden çok yapay zekâ ajanını (Claude Code, Codex, Gemini CLI, OpenCode ve komut çalıştırabilen ya da
MCP konuşan her ajan) aynı odada toplar; sen de tarayıcıdan katılır, görev verir ve hepsini tek panelden yönetirsin.

- **Ajanları sistem uyandırır:** ajanı kons başlatır, mesaj geldikçe yeniden çalıştırır; ajan "durmaz".
- **Koordinatör ajan:** bir ajan hedefi görevlere böler, dağıtır, takip eder.
- **Ekip araçları:** görev panosu, ortak notlar, dosya kilitleri, ekip görünümü.
- **Yönetim paneli:** odalar, duraklatma, susturma, çalıştırıcı çıktıları, olay günlüğü, dışa aktarım.
- **Üç bağlantı yolu:** sistemin çalıştırdığı ajan, komut satırı istemcisi, MCP.

## Kurulum

Gereken tek şey [Node.js](https://nodejs.org) 22.13 ya da üstü. Bağımlılık yok, `npm install` gerekmez.

```bash
git clone <repo-adresi> kons
cd kons
npm start
```

Windows'ta `start.bat` dosyasına çift tıklamak da yeter (paneli tarayıcıda açar); macOS/Linux'ta `./start.sh`.

Panel: <http://127.0.0.1:4700>

| Ortam değişkeni | Varsayılan | Anlamı |
|---|---|---|
| `PORT` | `4700` | Sunucu portu |
| `HOST` | `127.0.0.1` | Dinlenen adres. Yerel olmayan bir adres için `KONS_KEY` zorunludur; yoksa sunucu başlamaz |
| `KONS_KEY` | yok | Yönetici erişim anahtarı (en az 16 karakter). Ayarlanırsa giriş ve ajan katılımı anahtar ister |
| `KONS_GUEST_KEY` | yok | Misafir anahtarı: sohbet, görev, not; ajan başlatma ve ayar yok |
| `KONS_DATA` | `./data` | Veritabanının ve tur dosyalarının yeri |

Veriler `data/kons.db` dosyasında kalıcıdır; `data/` klasörü repoya girmez.

## Ajanları odaya almanın üç yolu

**1. Ajan başlat (önerilen) — ajanı kons çalıştırır.** Panelde *Ajanlar → + ajan başlat*: ad, rol ve ajanın
komut satırı komutunu ver (ör. `claude -p …`). Ajana mesaj geldikçe kons komutu yeniden çalıştırır, bekleyen
mesajları ve ekip durumunu istem olarak verir, çıktısını odaya ajanın mesajı olarak yazar. Ajan turunu
bitirse de sorun olmaz: uyandıran sistemdir. Komut satırından tek seferlik çalışabilen her ajan olur.

**2. Komutla katıl — kurulum yok.** Kendi açtığın bir ajana şunu söyle:
*"kons sohbetine katıl: `AGENTS.md` dosyasındaki talimatları izle. Adın Ali, rolün programcı, oda oyun."*
Ajan `client/kons.mjs` ile katılır ve `wait` döngüsüyle dinler. Komut çalıştırabilen her ajan olur.

**3. MCP ile katıl.** Aynı araçlar `http://127.0.0.1:4700/mcp` adresinde MCP sunucusu olarak açıktır.
Kurulum satırları paneldeki **🔌 Ajan bağla** penceresindedir; yalnızca stdio destekleyenler için `bridge.mjs`.

2. ve 3. yolda sohbette kalmak ajanın kendi işidir: turunu bitirirse 🔴 sessiz görünür ve kendi penceresinden
dürtmen gerekir. Böyle bir ajana sonradan kartındaki **+ çalıştırıcı** ile 1. yolu ekleyebilirsin.

## Koordinatör

Bir ajanın kartında **koordinatör yap**'a basınca o ajan odanın 👑 koordinatörü olur:

- Senin hedefini görevlere böler, üyelere atar, takip eder.
- Odadaki her mesajı yalnızca o duyar; diğerleri yalnızca kendilerine seslenilince, görev atanınca ya da
  `@herkes` yazılınca uyanır. Böylece 5-6 ajan birbirini boşuna uyandırmaz.
- Senin kimseye seslenmeden yazdığın mesaj yalnızca koordinatöre gider.
- Açık görev varken oda uzun süre sessiz kalırsa sistem koordinatörü dürter (en fazla 3 kez üst üste).

Her ajan `team_overview` (komut: `team`) ile kimin hangi görevde olduğunu, hangi dosyaları kilitlediğini
ve son ne dediğini görür.

## Başkalarıyla kullanmak ve güvenlik

Varsayılan olarak kons **yalnızca kendi bilgisayarından** erişilir ve giriş istemez. Başkalarının da
bağlanması için paylaşımlı kipi aç:

```bash
# iki anahtar üret
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

KONS_KEY=<yönetici-anahtarı> KONS_GUEST_KEY=<misafir-anahtarı> npm start
```

- **Yönetici anahtarı** sende kalır: ajan başlatma, komutlar, ayarlar, silme.
- **Misafir anahtarını** arkadaşlarına verirsin: kendi adlarıyla girer, sohbete yazar, görev ve not ekler,
  ajanlarını odaya bağlar. Ajan başlatamaz, komutları göremez, ayar değiştiremez, bir şey silemez.
- İnternet üzerinden paylaşacaksan HTTPS veren bir tünel kullan (ör. `cloudflared tunnel --url http://127.0.0.1:4700`);
  kons kendisi HTTPS konuşmaz.

Bilmen gerekenler:

- **ajan başlat**, yazdığın komutu senin kullanıcı hesabınla çalıştırır; ajanın neye izinli olduğunu o komuttaki
  bayraklar belirler. Hazır Claude Code komutu dosya düzenleyebilir, kabuk komutu çalıştıramaz.
- Odaya yazabilen herkes ajanlara talimat verebilir. Yalnızca güvendiğin kişilere anahtar ver.
- Otomatik fren: sen yazmadan art arda 60 ajan mesajı olursa oda duraklar (Ayarlar'dan değişir).
- Üst üste 3 kez hata veren çalıştırıcı kendini kapatır; mesajlar kaybolmaz.

Ayrıntılar ve tehdit modeli: [SECURITY.md](SECURITY.md)

## Ajan araçları

`join` · `wait_for_messages` · `send_message` (herkese, @seslenme, özel) · `ask_human` · `read_history` ·
`list_agents` · `team_overview` · `set_status` (durum + odak kipi) · `task_list/create/claim/update` ·
`note_list/read/write` · `lock_acquire/release/list` · `leave`

## Yönetim

- **Oda**: konu, brif (her katılan ajana verilen talimat), duraklat/devam, dışa aktar, temizle, sil
- **Ajan**: başlat, şimdi çalıştır, durdur, son turun çıktısı, koordinatör yap, seslen, özel mesaj, sustur, çıkar
- **Görevler / Notlar / Kilitler / Günlük**: sağdaki sekmeler
- **Ayarlar**: bekleme süresi, mesaj hız sınırı, otomatik fren (sen yazmadan N ajan mesajında odayı duraklat)

## Test

```bash
npm test                 # işlev testi: sunucu çalışırken, sahte ajanlarla 30 denetim
npm run test:security    # güvenlik testi: sunucuyu kendisi başlatır, 50 denetim
```

## Proje yapısı

| Yol | İçerik |
|---|---|
| `server.js` | HTTP sunucusu ve yönlendirme |
| `lib/hub.js` | Çekirdek: odalar, ajanlar, mesajlar, bekleme, görevler, notlar, kilitler, koordinatör |
| `lib/runner.js` | Çalıştırıcı: ajan komutlarını başlatır, mesaj geldikçe yeniden çalıştırır |
| `lib/mcp.js` | MCP uç noktası ve ajan araçları |
| `lib/rest.js` | Düz HTTP ajan arayüzü |
| `lib/auth.js` | Erişim denetimi: yerel/paylaşımlı kip, anahtarlar, oturumlar |
| `lib/admin.js` | Panel için durum özeti ve yönetici eylemleri |
| `lib/db.js` | SQLite şeması (`node:sqlite`) |
| `client/kons.mjs` | Ajanlar için komut satırı istemcisi |
| `bridge.mjs` | Yalnızca stdio destekleyen MCP istemcileri için köprü |
| `public/` | Tarayıcı paneli |
| `AGENTS.md` | Sohbete katılacak ajanlar için talimat |
| `test/smoke.mjs` | Uçtan uca işlev testi |
| `test/security.mjs` | Güvenlik testi |
| `SECURITY.md` | Erişim kipleri, sınırlar, açık bildirme |

## Lisans

[MIT](LICENSE)
