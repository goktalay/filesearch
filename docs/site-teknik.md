# File Search — teknik bilgi föyü

Bu föydeki her bilgi uygulamanın kaynak kodundan doğrulanmıştır (sürüm 1.0.0). Kurulum dosyası boyutları ilk Windows derlemesinden sonra eklenecektir.

## Sistem gereksinimleri

- **İşletim sistemi:** Windows 10 veya 11, 64 bit (x64).
- **Kurulum:** `File-Search-Setup-<sürüm>.exe` ya da kurulumsuz `File-Search-Portable-<sürüm>.exe`.
  - Tüm kullanıcılar: `C:\Program Files\Mastertool\File Search`
  - Yalnız bu kullanıcı: `%LOCALAPPDATA%\Programs\Mastertool\File Search`
  - Başlat menüsü: **Master Tool › File Search**; masaüstü kısayolu.
- **Hesap:** Mastertool hesabı (giriş zorunlu, uygulama kodu `fs`). Başka bir Mastertool uygulamasında giriş yapılmışsa şifre sorulmaz (ortak oturum).
- **Ek disk:** arama dizini (belge metinlerinin sıkıştırılmış kopyası dahil) ve — yalnız açılırsa — OCR dil verisi (dil başına ~2–15 MB) ile konuşma modeli (75–547 MB).

## Teknoloji

| Bileşen | Sürüm | Görevi |
|---|---|---|
| Electron | 33.4.11 (Chromium 130.0.6723.191, Node.js 20.18.3) | Masaüstü uygulama |
| SQLite (better-sqlite3) | 3.49.2 (11.10.0), WAL | Yerel dizin, FTS5 tam metin araması |
| pdf.js (pdfjs-dist) | 4.10.38 (legacy derleme) | PDF metni ve başlığı |
| fflate | 0.8.3 | DOCX/XLSX/PPTX/ODF (ZIP) okuma |
| iconv-lite | 0.6.3 | Windows-1254/1252, RTF ve e-posta karakter kümeleri |
| Snowball stemmers | 0.6.0 | Türkçe ve İngilizce kök bulma |
| three.js | 0.180.0 | 3B kelime bulutu (WebGL) |
| tesseract.js | 7.0.0 (Tesseract LSTM, WebAssembly) | İsteğe bağlı OCR |
| whisper.cpp | 1.7.6 (`whisper-cli`, CPU) | İsteğe bağlı konuşmadan metne |
| FFmpeg (ffmpeg-static) | 6.1.1 | Konuşma için 16 kHz mono WAV |

Tüm işleme bu bilgisayarda yapılır; GPU hızlandırma yoktur.

## Mimari

- **Arayüz** (Electron ana süreci + pencereler) ve **dizinleyici** ayrı süreçlerdir. Dizinleyici `src/indexer/service.js` olarak Electron'un Node'unda (`ELECTRON_RUN_AS_NODE`) başlar; ana süreçle JSON iletileriyle konuşur (`{t:'req', id, m, a}` / `{t:'res'…}` / `{t:'ev'…}`). Çökerse artan beklemeyle (1–30 sn) son kayıt listesi ve ayarlarla yeniden başlatılır. Aynı ileti biçimi ileride adlandırılmış kanal üzerinden bir Windows hizmetine taşınabilir.
- **Arka plan:** "Windows oturumu açılınca başlat" varsayılan açıktır (`--hidden` ile yalnız tepside başlar); pencere kapatılınca (varsayılan) izleme tepside sürer, çıkış tepsi menüsünden. Gerçek bir Windows hizmeti değildir: kullanıcı oturumunda çalışır (yönetici kurulumu gerektirmez, kullanıcının ağ sürücülerini görür).
- **Oturum:** uygulama girişsiz açılmaz; çıkış yapılınca ya da oturum düşünce izleme durur, dizin ve kayıtlar silinmez.

## Kayıtlar ve izleme

- **Yeni:** önce klasör seçilir, sonra ad (klasör adı önerilir), renk (11 renk), hariç tutma kalıpları (satır başına; `*` ad içinde her şey, `**` alt klasörler dahil, `?` tek karakter; `/` içermeyen kalıp yolun herhangi bir parçasıyla eşleşir; büyük/küçük harf duyarsız; varsayılan `node_modules`, `.git`, `$RECYCLE.BIN`, `System Volume Information`, `~$*`, `*.tmp`, `Thumbs.db`, `desktop.ini`) ve isteğe bağlı en büyük dosya (MB, 0 = genel ayar).
- **Tarama:** tüm alt klasörler ve dosyalar; aynı anda 24 dosya bilgisi okunur, 400'lük işlemlerle yazılır. Sembolik bağlar ve bağlantı noktaları izlenmez (döngü ve kayıt dışına taşma olmasın). İzin verilmeyen alt klasörler atlanır.
- **İzleme:** kök klasörde tek bir yinelemeli `fs.watch`. Olaylar 400 ms birleştirilir (sürekli yazılan dosyada en geç 3 sn'de bir). Dizinleyici değişen yolun o anki durumuna bakar: dosya eklendi/değişti (boyut ya da tarih), klasör eklendi/taşındı (alt ağaç taranır) ya da silindi (alt ağaç dizinden çıkar). 2000'den fazla değişiklik ya da bilinmeyen değişiklik tam fark taramasına döner.
- **Fark taraması:** açılışta, duraklatma sonrası, kayıt ayarı (hariç tutma, boyut sınırı) değişince, izleme düşünce ve ağ sürücülerinde (UNC yolları ve `net use` ile eşlenmiş harfler) 10 dakikada bir. Değişmeyen dosyalar yeniden okunmaz. Erişilemeyen kök ("Klasör bulunamadı" / "Ağ sürücüsüne ulaşılamıyor") 30 sn'de bir yeniden denenir.
- **Kart ve durum çubuğu:** toplam boyut, dosya ve klasör sayısı, dizinlenen/bekleyen/okunamayan dosya sayısı ve durum (Taranıyor · Dizinleniyor %n · İzleniyor · Duraklatıldı) en çok 400 ms'de bir güncellenir. Kayıt ya da tümü duraklatılabilir (tepsi menüsünden de).

## Metin çıkarma

| Tür | Uzantılar | Yöntem |
|---|---|---|
| Metin | txt md markdown log csv tsv json xml yaml yml ini cfg conf toml properties srt vtt tex rst nfo env | Kodlama algılama: BOM, BOM'suz UTF-16 (sıfır bayt deseni), geçerli UTF-8; değilse Windows-1254. İkili dosya (sıfır bayt) atlanır |
| Kod | js mjs cjs ts jsx tsx py java c h cpp hpp cc cs go rs rb php sh bat cmd ps1 sql css scss less vue svelte kt swift m r pl lua dart scala vb vbs asm gradle, Makefile/Dockerfile | Metin gibi |
| PDF | pdf | pdf.js; sayfa metni (en çok 2000 sayfa), belge başlığı. Parola korumalı PDF "okunamadı" |
| Word | docx docm dotx · odt · rtf | Gövde, üst/alt bilgi, dipnot, yorumlar; ODF content.xml; RTF: `\ansicpg`, `\'hh`, `\uN`, görünmeyen gruplar atlanır |
| Excel | xlsx xlsm xltx · ods | Sayfa adları, paylaşılan metinler, satır içi metin ve sayılar (satır başına sekmeli) |
| PowerPoint | pptx pptm potx · odp | Slayt metinleri sırayla ve konuşmacı notları |
| Web | html htm xhtml mht | Betik/stil atılır, HTML varlıkları çözülür, `<title>` başlık |
| E-posta | eml | Konu (RFC 2047), gönderen/alıcı/tarih, çok parçalı gövde (quoted-printable, base64, karakter kümesi; düz metin tercih edilir), ek adları |

- Metin dosya başına en çok **2 000 000 karakter** dizinlenir; önizlemede ilk 300 000 karakter gösterilir.
- İçeriği okunacak en büyük dosya varsayılan **50 MB** (1–4096; kayıt başına ayrıca). Daha büyük dosyalar ve okunamayan türler adlarıyla bulunur.
- Aynı anda metni çıkarılan dosya: 1–8, varsayılan 2. OCR ve konuşma tek tek, ayrı kuyrukta.

## Arama

- **Dizin:** FTS5 (içeriksiz, `unicode61 remove_diacritics 2`), üç sütun: dosya adı, katlanmış içerik, kökler. Belge metni ayrıca deflate ile saklanır (vurgulu parça ve önizleme için).
- **Katlama:** küçük harf, aksansız, `ı → i` (Türkçe büyük harf kuralıyla): `ŞEHİR`, `Şehir`, `sehir` aynı.
- **Kök:** belge dili ilk ~4000 kelimeden tahmin edilir (Türkçe/İngilizce durak kelimeler ve ğ ş ı İ harfleri); kökler o dille çıkarılır, dil bilinmiyorsa iki dilin kökü. Sorgudaki kelime her iki dilin köküyle aranır (`raporlarda → rapor`, `reports → report`).
- **Önek:** 3 harf ve üzeri kelimeler önek olarak da aranır (`kitapl` → kitaplık).
- **Sözdizimi:** boşlukla ayrılan kelimeler VE; `"tam ifade"` kelimeler yan yana ve sırasıyla; `-kelime` hariç tutar.
- **Dosya adı:** adlar camelCase, alt çizgi, tire ve noktadan bölünür; ad eşleşmesi içerikten 8 kat ağırlıklı (bm25).
- **Yazım hatası:** sonuç bulunamazsa (Ayarlar › Arama'dan kapatılabilir) dizinde olmayan 4+ harfli kelimeler için sözlükteki yakın yazımlar (Damerau-Levenshtein: 4–7 harfte 1, 8+ harfte 2 düzenleme; en sık 6 aday) eklenir ve "Yazım hatası düzeltildi" notu gösterilir.
- **Sonuçlar:** ad (vurgulu), kayıt › klasör yolu, en çok eşleşmeyi içeren ~220 karakterlik vurgulu parça, tarih, boyut, eşleşme sayısı; OCR/konuşma kaynaklı sonuçlarda rozet. Sayfa başına 50 (daha fazla göster). Sıralama: ilgi (bm25), en yeni, en büyük, ad.
- **Filtreler:** kayıt; tür (PDF, Word, Excel, PowerPoint, metin, kod, web sayfası, e-posta, resim, ses, video, arşiv, diğer); tarih (her zaman, 7 / 30 gün, 1 yıl); boyut (<1 MB, 1–10, 10–100, >100 MB).
- **Kayıt içinde arama:** kayıt penceresinde yalnız o kayıt (en çok 500 sonuç), alt klasör yoluyla.

## Kelime bulutları

- **Belge bulutu:** belgenin en sık 40 kelimesi; kök başına sayılır, en sık yazımı gösterilir; Türkçe ve İngilizce durak kelimeler, sayılar, 3 harften kısa kelimeler, e-posta ve web adresleri çıkarılır (e-postada başlık satırları sayılmaz). Kelimeye tıklayınca o kelimeyle aranır.
- **3B bulut:** aramanın "3B kelime bulutu" sekmesi (ana ekrandan da açılır). Kapsam: tüm dizin, filtrede seçili kayıt ya da arama sonuçları (ilk 500 sonuç). 60 / 120 / 200 kelime (en çok 400). Fibonacci küre dağılımı; boyut ve parlaklık sıklığa göre; arka yüzdeki kelimeler soluk. Sürükle → döndür, tekerlek → yakınlaştır, çift tık / Sıfırla → başa dön, bırakınca yavaş kendi dönüşü (azaltılmış hareket tercihinde durur). Üzerine gelince sayı ve belge sayısı; tıklayınca arama. Gece/gündüz temasına göre renk.

## OCR ve konuşmadan metne

İkisi de **varsayılan kapalıdır**; kapalıyken hiçbir şey indirilmez ve çalıştırılmaz, ilgili dosyalar "OCR kapalı" / "Konuşma kapalı" olarak bekler (adlarıyla bulunur). Açılınca ana süreç eksik veriyi indirir (Windows proxy ayarlarına uyar), dizinleyici bekleyen dosyaları işler. Kapatılınca daha önce okunmuş metinler dizinde kalır.

- **OCR:** jpg jpeg png bmp tif tiff gif webp; tesseract.js 7 ("best_int" verisi, jsDelivr › @tesseract.js-data). 13 dil (Türkçe, İngilizce, Almanca, Fransızca, İspanyolca, İtalyanca, Portekizce, Felemenkçe, Rusça, Arapça, Basitleştirilmiş Çince, Japonca, Korece), en çok 6 dil birlikte (varsayılan Türkçe + İngilizce). Resim boyutu sınırı içerik sınırıyla aynı.
- **Konuşma:** ses (mp3 wav flac m4a aac ogg oga opus wma aiff aif amr) ve video (mp4 mkv avi mov wmv webm m4v mpg mpeg flv 3gp mts); FFmpeg ile 16 kHz mono WAV, whisper.cpp ile metin (iş parçacığı: çekirdek − 1, en çok 4). Modeller: Çok küçük (75 MB), Temel (142 MB, varsayılan), Küçük (466 MB), Large v3 Turbo q5 (547 MB) — Hugging Face › ggerganov/whisper.cpp. Dil: otomatik ya da Türkçe, İngilizce, Almanca, Fransızca, İspanyolca, İtalyanca, Arapça, Rusça, Çince. whisper.cpp kurulumla gelir (yoksa ilk açılışta GitHub'dan indirilir).

## Depolama

`%APPDATA%\Mastertool\File Search\`:

| Yol | İçerik |
|---|---|
| `index.db` (+ `-wal`, `-shm`) | Dizin: dosya ağacı, FTS5, sıkıştırılmış metinler, kelime bulutları |
| `store.json` | Kayıtlar, ayarlar; `local` bölümünde cihaza özgü klasör yolları |
| `account.json` | Oturum (Windows DPAPI ile şifreli, "Beni hatırla") |
| `ocr\`, `models\`, `engines\whisper\` | OCR dil verileri, konuşma modelleri, (gerekirse) whisper.cpp |
| `work\` | Konuşma için geçici WAV dosyaları (iş bitince silinir) |

Dosyalarınız hiçbir zaman değiştirilmez. Ayarlar › Depolama: dizin boyutu, **Dizini sıfırla** (silinir ve tüm kayıtlar baştan taranır), veri klasörünü aç. OCR/konuşma verileri Ayarlar › Arama'dan silinebilir. Dizin şeması değişirse kendiliğinden yeniden kurulur.

## Güvenlik ve gizlilik

- Dizin, dosya içerikleri, OCR ve konuşma metinleri **yalnız bu bilgisayarda** tutulur.
- **Senkron (uçtan uca şifreli, kapatılabilir):** yalnız kayıtların adı, rengi, hariç tutma kalıpları, boyut sınırı ve genel ayarlar. Klasör yolları cihaza özeldir (başka cihazda kayıt açılınca klasör sorulur). Anahtar şifreden cihazda türetilir: PBKDF2-SHA256 (310 000 tur) + HKDF-SHA256 (`fsr-enc-v1`), AES-256-GCM; sunucu içeriği okuyamaz.
- **Ortak oturum:** Windows Kimlik Bilgisi Yöneticisi (`Mastertool/sso`) ve `%APPDATA%\Mastertool\sso-state.json` (Mastertool `sso.js` ile birebir); birinde çıkış tüm ailede çıkış yapar.
- **Ağ** yalnız şunlar için: mastertool.download (giriş, senkron, sürüm denetimi — açılış denetimi Ayarlar › Genel'den kapatılabilir), OCR verisi / konuşma modeli / whisper.cpp indirme (yalnız seçenek açıkken), hesap sayfaları ve Mastertool düğmesi (tarayıcıda).
- Pencereler bağlam yalıtımıyla çalışır. Önizleme dosyaları yalnız ana sürecin belge ayrıntısı için kaydettiği `fsr://` adresleriyle açılır (SVG için betik kapalı CSP). Aç / Klasörde göster / Yolu kopyala işlemleri pencereden yol değil, dizindeki belge kimliği alır.

## Klavye kısayolları

| Kısayol | Pencere | İşlev |
|---|---|---|
| Ctrl+N | Ana | Yeni kayıt |
| Ctrl+F | Ana, Kayıt | Arama kutusu |
| Enter / F2 / Delete | Ana | Seçili kaydı aç / ayarları / sil |
| ↑ / ↓ | Ana (arama), Kayıt | Önceki / sonraki sonuç ya da dosya |
| Esc | Ana, Kayıt | Aramayı temizle |
| F5 | Kayıt | Yeniden tara |
| Backspace | Kayıt | Üst klasör |
| Enter | Kayıt | Seçili dosyayı aç / klasöre gir |

## Diller ve görünüm

- **8 dil:** Türkçe, English, Français, Deutsch, Español, العربية (sağdan sola), 中文, Русский; ilk açılışta Windows dili (yoksa İngilizce).
- **Tema:** Gece / Gündüz / Sistem (varsayılan Sistem). Panel genişlikleri hatırlanır.

## Bilinen sınırlar

- Eski ikili Office biçimleri (`.doc`, `.xls`, `.ppt`), Outlook `.msg`, arşivlerin (`zip`, `rar`, `7z`) içi ve şifreli belgeler okunmaz; bunlar adlarıyla bulunur.
- Taranmış (resim içeren) PDF'lerde OCR yapılmaz; OCR yalnız resim dosyalarına uygulanır.
- Kök bulma yalnız Türkçe ve İngilizce içindir; diğer dillerde katlama ve önek araması yapılır. Türkçe kök bulucu ad çekim eklerini kaldırır, fiil çekimlerinde sınırlıdır.
- "Anlama göre" (anlamsal/vektör) arama bu sürümde yoktur.
- Dosya başına ilk 2 000 000 karakter dizinlenir.
- Yazım hatası düzeltmesi yalnız sonuç bulunamadığında ve dizinde olmayan kelimeler için devreye girer.
- Gerçek bir Windows hizmeti değildir; kullanıcı oturumu kapalıyken ya da uygulamada çıkış yapılmışken izleme yapılmaz (açılışta fark taramasıyla yakalanır).
- Ağ sürücülerinde `fs.watch` olay kaçırabilir; bu nedenle 10 dakikada bir fark taraması yapılır (değişiklikler en geç bu sürede yansır).
- Kayıt penceresindeki listede klasör başına ilk 3000 öğe gösterilir (arama tümünü kapsar).
- 3B bulut WebGL ister; GPU yoksa yazılım çizimiyle (daha yavaş) çalışır.
- Windows dışında konuşmadan metne için `FSR_WHISPER_CLI` ile bir whisper-cli gösterilmelidir (uygulama yalnız Windows için derlenir).

## Sürüm geçmişi

### 1.0.0 — 16 Ekim 2026

- İlk sürüm: kayıtlar ve canlı boyut/sayılar, kayıt penceresi (ağaç, liste, önizleme), arka planda izleme ve fark taraması, ayrı dizinleyici süreci.
- Metin çıkarma: metin/kod, PDF, Word, Excel, PowerPoint, OpenDocument, RTF, HTML, e-posta.
- Akıllı arama: Türkçe/İngilizce kök, katlama, önek, tam ifade, hariç tutma, yazım hatası düzeltme, filtreler, vurgulu parça.
- İsteğe bağlı OCR ve konuşmadan metne (varsayılan kapalı); belge kelime bulutu ve 3B kelime bulutu.
- Mastertool hesabı, ortak oturum, uçtan uca şifreli senkron, 8 dil, tema, tepsi, Windows ile başlat.
