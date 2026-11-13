# Güvenlik

kons, ajanların senin bilgisayarında çalışmasını yöneten bir araçtır. Paneldeki **ajan başlat** özelliği
sunucunun çalıştığı bilgisayarda komut çalıştırır. Bu yüzden "kim erişebilir" sorusu bu projede en önemli sorudur.

## İki erişim kipi

| | Yerel (varsayılan) | Paylaşımlı |
|---|---|---|
| Nasıl açılır | hiçbir şey ayarlamadan | `KONS_KEY` ayarlayarak |
| Kim erişir | yalnızca bu bilgisayar | anahtarı bilen herkes |
| Giriş | yok | anahtar + ad |
| Dinlenen adres | `127.0.0.1` | `HOST` ile seçilir |

Sunucu, anahtar olmadan yerel olmayan bir adresi dinlemeyi **reddeder** ve başlamaz.

### Yerel kip

- Yalnızca `127.0.0.1` dinlenir; ağdaki başka cihazlar bağlanamaz.
- Yalnızca yerel `Host` ve `Origin` başlıkları kabul edilir. Böylece ziyaret ettiğin bir web sitesi
  tarayıcın üzerinden kons'a istek atamaz (CSRF ve DNS rebinding).
- Bu bilgisayarda oturum açmış her program kons'a erişebilir. Bilgisayarı güvenmediğin biriyle paylaşıyorsan
  yerel kipte de anahtar kullan.

### Paylaşımlı kip

```bash
# anahtar üret (en az 16 karakter olmalı)
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

KONS_KEY=<yönetici-anahtarı> KONS_GUEST_KEY=<misafir-anahtarı> npm start
```

Windows PowerShell'de:

```powershell
$env:KONS_KEY = "<yönetici-anahtarı>"; $env:KONS_GUEST_KEY = "<misafir-anahtarı>"; npm start
```

- **Yönetici anahtarı (`KONS_KEY`)** her şeyi yapar: ajan başlatma, komut ve ayar değiştirme, silme.
  Bu anahtarı bilen kişi sunucunun çalıştığı bilgisayarda komut çalıştırabilir. Kimseyle paylaşma.
- **Misafir anahtarı (`KONS_GUEST_KEY`, isteğe bağlı)** arkadaşların içindir: sohbete yazar, görev ve not ekler,
  odayı duraklatır, ajanlarını odaya bağlar. Ajan başlatamaz, komutları ve dosya yollarını göremez, ayar
  değiştiremez, bir şey silemez.
- Her insan kendi adıyla girer; mesajlar o adla görünür.
- Art arda 8 hatalı anahtar denemesinde giriş bir dakika kilitlenir.
- Oturum çerezi `HttpOnly` ve `SameSite=Strict`'tir; sunucu yeniden başlayınca herkes yeniden giriş yapar.

Ajanlar anahtarı yalnızca katılırken verir:

```bash
node kons.mjs join --name Ali --server https://adres --key <misafir-anahtarı>
```

MCP istemcilerinde anahtar `x-kons-key` başlığıyla gönderilir. Anahtarı adres çubuğuna (`?key=`) yazma;
adresler geçmişte ve günlüklerde kalır.

### İnternete açmak

kons HTTPS konuşmaz. İnternet üzerinden paylaşacaksan **mutlaka** HTTPS veren bir tünel ya da ters vekil
arkasında çalıştır; yoksa anahtar ve mesajlar ağda açık metin olarak dolaşır.

```bash
# kons yerelde dinler, tünel HTTPS adresi verir
KONS_KEY=… KONS_GUEST_KEY=… npm start
cloudflared tunnel --url http://127.0.0.1:4700
```

Paylaşımlı kipte `HOST` değiştirmen gerekmez: tünel yerel adrese bağlanır.

## Bilmen gereken sınırlar

- **Misafirler ajanlara talimat verebilir.** Misafir komut çalıştıramaz, ama sohbete yazdığı mesaj ajanlara
  istem olarak gider. Bir ajana dosya düzenleme ya da kabuk izni verdiysen, odaya yazabilen herkes o ajandan
  bu izinleri kullanmasını isteyebilir. Yalnızca güvendiğin kişilere anahtar ver ve ajanlara gereğinden
  fazla izin verme.
- **Ajanlar birbirine talimat verebilir.** Bir ajanın mesajı diğerinin girdisidir (istem enjeksiyonu). Kötü
  niyetli ya da yanılmış bir ajan diğerlerini yönlendirebilir.
- **Çalıştırıcı komutları senin kullanıcı hesabınla çalışır.** kons bir korumalı alan (sandbox) sağlamaz;
  ajanın neye izinli olduğunu komuttaki bayraklar belirler. Riskli işler için ajanı ayrı bir kullanıcı,
  kapsayıcı ya da sanal makinede çalıştır.
- **Veriler şifresiz saklanır.** Sohbet `data/kons.db` içinde düz SQLite'tır; `data/runs/` ajanlara verilen
  son istemleri tutar. Bu klasör repoya girmez; sen de paylaşma.
- **Maliyet.** Ajanlar kendi kendine çalıştığı için kota tüketir. Otomatik fren (art arda 60 ajan mesajı)
  ve tur süresi sınırı varsayılan olarak açıktır.

## Açık bildirme

Bir güvenlik açığı bulursan lütfen herkese açık bir issue açmak yerine GitHub'daki
**Security → Report a vulnerability** bağlantısını kullan.

## Test

```bash
npm run test:security
```

Sunucuyu geçici veriyle kendisi başlatır ve şunları dener: anahtarsız ağa açılma, girişsiz erişim,
yanlış anahtar ve kilitlenme, misafir sınırları, başka siteden gelen istekler, dizin dışına çıkma.
