# File Search

Windows için klasör dizinleme ve belgelerin içinde akıllı arama aracı. Mastertool ailesinin **Araçlar** grubundandır (uygulama kodu `fs`); kendi sitesi yoktur, tanıtımı [mastertool.download/araclar/file-search](https://mastertool.download/araclar/file-search), indirme Hesabım ve Master Tool üzerinden.

## Özellikler

- **Kayıtlar:** "Yeni" önce klasörü sorar (yerel ya da ağ sürücüsü, `\\sunucu\paylaşım`), ardından ad, renk, hariç tutma kalıpları ve isteğe bağlı boyut sınırı. Kart üzerinde canlı **toplam boyut**, dosya ve klasör sayısı, dizinleme/izleme durumu. Ana ekranda izlenen klasörlerde **son değişen dosyalar**.
- **Kayıt penceresi:** solda klasör ağacı (tüm alt klasörler, boyutlarıyla), ortada dosya listesi (boyut, tür, tarih, dizin durumu; sıralanabilir), sağda önizleme (bilgiler, resim/ses/video, belgenin kelime bulutu, vurgulu metin); altta canlı durum çubuğu; yalnız bu kayıtta arama.
- **Arka planda sürekli çalışma:** Windows açılışında tepside başlar (varsayılan açık), pencere kapanınca izleme tepside sürer. Dizinleyici ayrı bir süreçtir (`src/indexer/service.js`, JSON iletili IPC); ileride bir Windows hizmetine taşınabilir.
- **İzleme:** yinelemeli `fs.watch` (Windows'ta ReadDirectoryChangesW, tüm ağaç için tek tanıtıcı); yeni/değişen/silinen/taşınan dosya ve klasörler dizine anında yansır. Açılışta ve ağ sürücülerinde 10 dakikada bir hızlı fark taraması; erişilemeyen kök 30 saniyede bir yeniden denenir.
- **Dizin:** SQLite FTS5 (better-sqlite3), `%APPDATA%\Mastertool\File Search\index.db`. Metin çıkarma: düz metin ve kod (UTF-8, UTF-16, Windows-1254 algılama), PDF (pdf.js), Word/Excel/PowerPoint (docx/xlsx/pptx), OpenDocument (odt/ods/odp), RTF, HTML, e-posta (.eml).
- **Akıllı arama (üstte serbest metin):** Türkçe ve İngilizce kök bulma (Snowball), aksan ve büyük/küçük harf duyarsız (`sehir` = `Şehirlerde`), önek, `"tam ifade"`, `-hariç`, yazım hatasına dayanıklı (sözlükte yakın yazımlar), dosya adı + içerik; sonuçlarda vurgulu parça, yol, tarih, boyut; filtreler (tür, tarih, boyut, kayıt); sıralama.
- **Arama ayarları:** "Resimlerde metin oku (OCR)" (tesseract.js 7) ve "Ses ve videoda konuşmayı metne çevir" (whisper.cpp) — **ikisi de varsayılan kapalı**; kapalıyken hiçbir şey indirilmez ve çalıştırılmaz. Açılınca dil verisi / model indirilir.
- **Kelime (etiket) bulutu:** her belgenin en sık kelimeleri (Türkçe/İngilizce durak kelimeler, sayılar ve adresler çıkarılır; kök başına birleştirilir).
- **3B kelime bulutu:** aramanın içindeki ayrı sekme; tüm dizinin, seçili kaydın ya da sonuçların kelimeleri three.js ile kürede; sıklığa göre boyut, sürükleyerek döndürme, tekerlekle yakınlaştırma, kelimeye tıklayınca arama.
- **Gizlilik:** dizin ve dosya içerikleri yalnız bu bilgisayarda. Senkronlanan tek şey kayıtların adı, rengi ve ayarları (uçtan uca şifreli); klasör yolu cihaza özeldir.
- **Mastertool standardı:** aynı hesap ve ortak oturum (SSO), 8 dil (tr, en, fr, de, es, ar sağdan sola, zh, ru), Gece/Gündüz/Sistem teması, bölümlü ayarlar (Genel / Hesap / Arama / Depolama / Hakkında), tepsi, sağ üstte Mastertool düğmesi.

## Kurulum

- `File-Search-Setup-x.y.z.exe` — `C:\Program Files\Mastertool\File Search`, Başlat menüsü › Master Tool › File Search
- `File-Search-Portable-x.y.z.exe` — kurulumsuz

## Geliştirme

```bash
npm install
npm test
```

Dizinleyici Electron'un kendi Node'unda çalıştığından `better-sqlite3`'ün Electron için derlenmesi gerekir:

```bash
npm run rebuild:electron && npm start
```

Ya da derlemeden, dizinleyiciyi sistemdeki Node ile çalıştırarak: `npm run start:node-indexer` (`FSR_NODE`). `npm test` gerekirse modülü Node için yeniden derler.

Sahte hesap sunucusu (test@example.com / Test1234!): `node test/mock-server.js 8787`, sonra `FSR_API=http://127.0.0.1:8787 npm start`.

Örnek veri: `npm run sample -- <klasör> [tr|en]`. Tanıtım görüntüleri: `npm run screenshots` (playwright-core ve Chromium gerekir; `CHROMIUM_PATH`, `PLAYWRIGHT_CORE`).

Ortam değişkenleri: `FSR_API`, `FSR_NODE`, `FSR_OCR_LANG_BASE`, `FSR_FFMPEG`, `FSR_WHISPER_CLI`, `FSR_WHISPER_VERSION`.

## Exe derleme ve yayın

GitHub Actions (`.github/workflows/release.yml`, Windows): `v1.2.3` etiketi gönderilince ya da Actions'tan elle ("release" işaretli) çalıştırılınca derler, Release'e ekler ve `scripts/upload-filesearch.sh` ile mastertool.download'a parçalı yükler (`POST /api/fs/releases/<sürüm>/setup`, sonra `/portable`; `X-Release-Key` = depo gizli değeri `FILESEARCH_RELEASE_KEY`). "release" işaretsiz elle çalıştırma yalnız derler (artifact).

Teknik ayrıntılar ve bilinen sınırlar: [docs/site-teknik.md](docs/site-teknik.md).
