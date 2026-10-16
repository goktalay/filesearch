// Tanıtım görüntüleri ve elle deneme için örnek klasörler üretir (kurgusal içerik; gerçek kişisel veri yok).
// Kullanım: node scripts/sample-data.js <hedef klasör> [tr|en]
'use strict';

const fs = require('fs');
const path = require('path');
const F = require('../test/fixtures');

const lorem = (lines, n) => Array.from({ length: n }, (_, i) => lines[i % lines.length]).join('\n');

const TR = {
  'Proje Arşivi': {
    'Teklifler/2026-Q3 Teklif - Liman Deposu.docx': F.docx([
      'Liman Deposu Yenileme Projesi — Teklif',
      'Bu teklif, liman deposunun çatı yalıtımı, yangın algılama sistemi ve raf düzeninin yenilenmesini kapsar.',
      'Proje süresi 14 hafta olarak planlanmıştır. Malzeme listesi ve bütçe ekte sunulmuştur.',
      'Yangın algılama sistemi için iki farklı üretici değerlendirilmiştir; bakım maliyeti düşük olan seçenek önerilmektedir.',
      'Teslim sonrası 24 ay garanti ve yılda iki kez periyodik bakım teklife dahildir.',
      'Depo yenileme çalışmaları sırasında liman operasyonları aksamayacak şekilde gece vardiyası planlanmıştır.',
    ], { title: 'Liman Deposu Teklifi' }),
    'Teklifler/Bütçe özeti.xlsx': F.xlsx({ Bütçe: [['Kalem', 'Tutar (TL)', 'Not'], ['Çatı yalıtımı', 420000, 'Taş yünü, 10 cm'], ['Yangın algılama', 185000, 'Adresli sistem'], ['Raf sistemi', 260000, 'Ağır yük rafı'], ['İşçilik', 310000, 'Gece vardiyası dahil'], ['Toplam', 1175000, '']], Takvim: [['Hafta', 'İş'], [1, 'Keşif ve ölçüm'], [3, 'Malzeme tedariki'], [6, 'Çatı yalıtımı'], [10, 'Yangın algılama kurulumu'], [14, 'Teslim ve eğitim']] }),
    'Sunumlar/Yönetim kurulu sunumu.pptx': F.pptx([
      { title: 'Liman Deposu Yenileme', body: ['Kapsam, bütçe ve takvim'], notes: 'Açılışta güvenlik iyileştirmelerini vurgula.' },
      { title: 'Neden şimdi?', body: ['Çatıda su sızıntısı', 'Yangın algılama yönetmeliği değişti', 'Raf kapasitesi yetersiz'] },
      { title: 'Bütçe', body: ['Toplam 1,175 milyon TL', 'İşçilik dahil', 'Bakım maliyeti düşük çözüm'] },
      { title: 'Takvim', body: ['14 hafta', 'Gece vardiyası ile kesintisiz liman operasyonu'] },
    ]),
    'Toplantı notları/2026-10-02 haftalık toplantı.md': '# Haftalık toplantı — 2 Ekim 2026\n\n## Katılanlar\nProje ekibi, satın alma, saha sorumlusu\n\n## Kararlar\n- Yangın algılama sistemi için ikinci üreticiden yeni fiyat istenecek.\n- Çatı yalıtımı malzemesi gelecek hafta sahaya teslim edilecek.\n- Raf sistemi ölçümleri tamamlandı; ağır yük rafı onaylandı.\n\n## Açık konular\n- Liman yönetimiyle gece vardiyası izni yazışması sürüyor.\n- Bütçe revizyonu yönetim kuruluna sunulacak.\n',
    'Toplantı notları/2026-10-09 haftalık toplantı.md': '# Haftalık toplantı — 9 Ekim 2026\n\n## Kararlar\n- İkinci üreticinin yangın algılama teklifi daha uygun; sözleşme taslağı hazırlanacak.\n- Çatı yalıtımı malzemesi teslim alındı, kalite kontrolü yapıldı.\n- Gece vardiyası izni liman yönetiminden alındı.\n\n## Riskler\n- Hava koşulları çatı çalışmasını geciktirebilir.\n',
    'Yazışmalar/Tedarikçi - yangın algılama fiyatı.eml': F.eml({ from: 'Satın Alma <satinalma@ornek-yapi.example>', to: 'Proje Ekibi <proje@ornek-yapi.example>', subject: 'Yangın algılama sistemi güncel fiyat', body: 'Merhaba,\n\nİkinci üreticiden gelen güncel fiyat teklifini ekte bulabilirsiniz. Adresli yangın algılama sistemi için bakım dahil toplam tutar 185.000 TL.\nTeslim süresi 3 hafta.\n\nİyi çalışmalar,\nSatın Alma', attachment: 'yangin-algilama-teklif.pdf' }),
    'Yazışmalar/Liman yönetimi - gece vardiyası.eml': F.eml({ from: 'Liman Yönetimi <liman@ornek-liman.example>', to: 'Proje Ekibi <proje@ornek-yapi.example>', subject: 'Gece vardiyası çalışma izni', body: 'Sayın ilgili,\n\nDepo yenileme çalışmaları için 22.00–06.00 saatleri arasında gece vardiyası izni verilmiştir. Çalışma alanında güvenlik görevlisi bulunması zorunludur.\n\nSaygılarımızla' }),
    'Şartname/Teknik şartname.rtf': F.rtf('Teknik Şartname\nÇatı yalıtımında yanmaz sınıf A1 taş yünü kullanılacaktır.\nYangın algılama sistemi adresli olmalı ve merkezi panele bağlanmalıdır.\nRaf sistemi raf başına 2 ton taşıma kapasitesine sahip olacaktır.\nTüm işler iş sağlığı ve güvenliği yönetmeliğine uygun yapılacaktır.'),
    'Şartname/Standartlar.pdf': F.pdf(['Fire detection standards summary', 'EN 54 series covers fire detection and fire alarm systems.', 'Addressable systems report the exact location of each detector.', 'Maintenance should be performed twice a year.', 'Warehouse roof insulation must use non-combustible A1 class material.'], { title: 'Fire detection standards' }),
    'Saha/rapor-sablonu.html': '<html><head><title>Saha günlük raporu</title></head><body><h1>Saha günlük raporu</h1><p>Tarih, hava durumu, çalışan sayısı, yapılan işler ve iş güvenliği gözlemleri bu şablona yazılır.</p><p>Çatı yalıtımı ve yangın algılama kurulumu ilerlemesi yüzde olarak belirtilir.</p></body></html>',
  },
  'Teknik Dokümanlar': {
    'Kurulum kılavuzu.md': '# Kurulum kılavuzu\n\nBu kılavuz, depo yönetim yazılımının sunucuya kurulumunu anlatır.\n\n## Gereksinimler\n- 4 çekirdekli işlemci, 8 GB bellek\n- PostgreSQL 16 veritabanı\n\n## Adımlar\n1. Kurulum paketini indirin.\n2. Yapılandırma dosyasında veritabanı bağlantısını tanımlayın.\n3. Hizmeti başlatın ve yönetim paneline giriş yapın.\n\n## Yedekleme\nVeritabanı yedeği her gece otomatik alınır. Yedekler 30 gün saklanır.\n',
    'API/stok-servisi.js': "'use strict';\n// Stok servisi: depo raflarındaki ürün miktarlarını getirir ve günceller\nconst express = require('express');\nconst router = express.Router();\n\n// Raf bazında stok listesi\nrouter.get('/raflar/:id/stok', async (req, res) => {\n  const stok = await db.stokGetir(req.params.id);\n  res.json(stok);\n});\n\n// Stok güncelleme (sayım sonrası)\nrouter.put('/raflar/:id/stok', async (req, res) => {\n  await db.stokGuncelle(req.params.id, req.body.miktar);\n  res.json({ ok: true });\n});\n\nmodule.exports = router;\n",
    'API/README.md': '# Stok API\n\nDepo raflarındaki stok bilgisini sağlayan REST servisi.\n\n- `GET /raflar/:id/stok` — rafın stok listesi\n- `PUT /raflar/:id/stok` — sayım sonrası stok güncelleme\n\nKimlik doğrulama için API anahtarı gereklidir.\n',
    'Ağ yapılandırması.txt': 'Depo ağ yapılandırması\n\nYönetim ağı: 10.20.0.0/24\nKamera ağı: 10.20.10.0/24\nYangın algılama paneli: 10.20.20.15\nKablosuz el terminalleri depo içinde 5 GHz bandında çalışır.\nGüvenlik duvarı kuralları her çeyrekte gözden geçirilir.\n',
    'Release notes.md': '# Release notes\n\n## 2.4.0\n- Barcode scanning is faster on handheld terminals.\n- Stock count reports can be exported to Excel.\n- Fixed a bug where shelf capacity warnings were not shown.\n\n## 2.3.0\n- New dashboard for warehouse occupancy.\n- Backup schedule can be configured from the admin panel.\n',
  },
  'Muhasebe': {
    '2026/Ekim faturaları.xlsx': F.xlsx({ Faturalar: [['Fatura no', 'Tedarikçi', 'Tutar', 'Durum'], ['F-2026-1041', 'Yalıtım Malzemeleri', 212000, 'Ödendi'], ['F-2026-1042', 'Raf Sistemleri', 130000, 'Bekliyor'], ['F-2026-1043', 'Yangın Güvenlik', 92500, 'Bekliyor'], ['F-2026-1044', 'Nakliye', 18400, 'Ödendi']] }),
    '2026/Gider raporu Eylül.docx': F.docx(['Eylül gider raporu', 'Toplam gider 486.300 TL olarak gerçekleşmiştir.', 'En büyük kalem çatı yalıtımı malzeme alımıdır.', 'Nakliye giderleri bütçenin altında kalmıştır.', 'Ödenmemiş faturalar Ekim ayına devredilmiştir.']),
    'Banka/hesap-ozeti-notlar.txt': 'Hesap özeti notları\n\nEylül sonu itibarıyla proje hesabında yeterli bakiye bulunmaktadır.\nTedarikçi ödemeleri vade tarihlerine göre planlanmıştır.\nKur farkı riski bulunmamaktadır; tüm ödemeler TL cinsindendir.\n',
  },
};

const EN = {
  'Project Archive': {
    'Proposals/2026-Q3 Proposal - Harbour Warehouse.docx': F.docx([
      'Harbour Warehouse Renovation — Proposal',
      'This proposal covers roof insulation, a new fire detection system and a new shelving layout for the harbour warehouse.',
      'The project is planned for 14 weeks. The bill of materials and the budget are attached.',
      'Two fire detection vendors were evaluated; the option with the lower maintenance cost is recommended.',
      'A 24-month warranty and maintenance twice a year are included.',
      'Work is scheduled on night shifts so that harbour operations are not interrupted.',
    ], { title: 'Harbour Warehouse Proposal' }),
    'Proposals/Budget summary.xlsx': F.xlsx({ Budget: [['Item', 'Amount', 'Note'], ['Roof insulation', 42000, 'Stone wool, 10 cm'], ['Fire detection', 18500, 'Addressable system'], ['Shelving', 26000, 'Heavy-duty racks'], ['Labour', 31000, 'Incl. night shift'], ['Total', 117500, '']] }),
    'Presentations/Board presentation.pptx': F.pptx([
      { title: 'Harbour Warehouse Renovation', body: ['Scope, budget and timeline'], notes: 'Open with the safety improvements.' },
      { title: 'Why now?', body: ['Roof leaks', 'New fire detection regulation', 'Shelving capacity is too low'] },
      { title: 'Budget', body: ['117,500 in total', 'Labour included', 'Low maintenance cost'] },
    ]),
    'Meeting notes/2026-10-02 weekly meeting.md': '# Weekly meeting — 2 October 2026\n\n## Decisions\n- Ask the second vendor for a new fire detection quote.\n- Roof insulation material will be delivered to the site next week.\n- Shelving measurements are done; heavy-duty racks approved.\n\n## Open items\n- Night shift permit from the harbour authority is pending.\n- Budget revision to be presented to the board.\n',
    'Meeting notes/2026-10-09 weekly meeting.md': '# Weekly meeting — 9 October 2026\n\n## Decisions\n- The second fire detection quote is better; draft the contract.\n- Roof insulation material received and inspected.\n- Night shift permit granted by the harbour authority.\n',
    'Mail/Vendor - fire detection quote.eml': F.eml({ from: 'Purchasing <purchasing@sample-build.example>', to: 'Project Team <project@sample-build.example>', subject: 'Updated fire detection quote', body: 'Hello,\n\nPlease find the updated quote from the second vendor attached. The addressable fire detection system costs 18,500 including maintenance.\nDelivery takes 3 weeks.\n\nBest regards,\nPurchasing', attachment: 'fire-detection-quote.pdf' }),
    'Specs/Technical specification.rtf': F.rtf('Technical Specification\nRoof insulation shall use non-combustible class A1 stone wool.\nThe fire detection system shall be addressable and connected to a central panel.\nEach shelf shall carry at least 2 tonnes.'),
    'Specs/Standards.pdf': F.pdf(['Fire detection standards summary', 'EN 54 series covers fire detection and fire alarm systems.', 'Addressable systems report the exact location of each detector.', 'Maintenance should be performed twice a year.'], { title: 'Fire detection standards' }),
  },
  'Technical Docs': {
    'Installation guide.md': '# Installation guide\n\nThis guide explains how to install the warehouse management software on a server.\n\n## Requirements\n- 4-core CPU, 8 GB RAM\n- PostgreSQL 16 database\n\n## Steps\n1. Download the installation package.\n2. Configure the database connection.\n3. Start the service and sign in to the admin panel.\n\n## Backup\nThe database is backed up every night and kept for 30 days.\n',
    'API/stock-service.js': "'use strict';\n// Stock service: reads and updates product quantities on warehouse shelves\nconst express = require('express');\nconst router = express.Router();\n\nrouter.get('/shelves/:id/stock', async (req, res) => {\n  res.json(await db.getStock(req.params.id));\n});\n\nrouter.put('/shelves/:id/stock', async (req, res) => {\n  await db.updateStock(req.params.id, req.body.quantity);\n  res.json({ ok: true });\n});\n\nmodule.exports = router;\n",
    'Network configuration.txt': 'Warehouse network configuration\n\nManagement network: 10.20.0.0/24\nCamera network: 10.20.10.0/24\nFire detection panel: 10.20.20.15\nHandheld terminals use the 5 GHz band inside the warehouse.\n',
    'Release notes.md': '# Release notes\n\n## 2.4.0\n- Barcode scanning is faster on handheld terminals.\n- Stock count reports can be exported to Excel.\n\n## 2.3.0\n- New dashboard for warehouse occupancy.\n',
  },
  'Accounting': {
    '2026/October invoices.xlsx': F.xlsx({ Invoices: [['Invoice', 'Vendor', 'Amount', 'Status'], ['INV-1041', 'Insulation Supplies', 21200, 'Paid'], ['INV-1042', 'Shelving Systems', 13000, 'Open'], ['INV-1043', 'Fire Safety', 9250, 'Open']] }),
    '2026/September expense report.docx': F.docx(['September expense report', 'Total expenses were 48,630.', 'The largest item was roof insulation material.', 'Unpaid invoices were carried over to October.']),
  },
};

// Biraz hacim: arşivde eski yıllara ait çok sayıda kısa not (ağaç ve boyut görünsün)
function bulk(set, lang) {
  const base = lang === 'tr' ? 'Proje Arşivi' : 'Project Archive';
  const words = lang === 'tr'
    ? ['depo', 'liman', 'yalıtım', 'yangın', 'raf', 'bütçe', 'teslim', 'bakım', 'güvenlik', 'tedarik', 'sözleşme', 'saha', 'vardiya', 'stok', 'kalite']
    : ['warehouse', 'harbour', 'insulation', 'fire', 'shelf', 'budget', 'delivery', 'maintenance', 'safety', 'supply', 'contract', 'site', 'shift', 'stock', 'quality'];
  for (const year of [2023, 2024, 2025]) {
    for (let m = 1; m <= 12; m++) {
      const name = `${lang === 'tr' ? 'Eski projeler' : 'Old projects'}/${year}/${String(m).padStart(2, '0')}/${lang === 'tr' ? 'aylık-rapor' : 'monthly-report'}.txt`;
      const body = lorem(words.map((w, i) => `${w} ${words[(i * 7 + m) % words.length]} ${words[(i * 3 + year) % words.length]}`), 40 + m * 3);
      set[base][name] = `${lang === 'tr' ? 'Aylık rapor' : 'Monthly report'} ${year}-${m}\n\n${body}\n`;
    }
  }
}

function write(root, set) {
  for (const [dir, files] of Object.entries(set)) {
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(root, dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
  }
}

// OCR denemesi için metin içeren resimler (sharp ile SVG'den)
async function images(root, lang) {
  let sharp;
  try { sharp = require('sharp'); } catch { return; }
  const items = lang === 'tr'
    ? [['Proje Arşivi/Saha/fotoğraflar/acil-cikis-tabelasi.png', ['ACİL ÇIKIŞ', 'Yangın merdiveni →']], ['Proje Arşivi/Saha/fotoğraflar/raf-etiketi.png', ['RAF B-12', 'Azami yük 2 ton']]]
    : [['Project Archive/Site/photos/emergency-exit-sign.png', ['EMERGENCY EXIT', 'Fire stairs →']], ['Project Archive/Site/photos/shelf-label.png', ['SHELF B-12', 'Max load 2 tonnes']]];
  for (const [rel, lines] of items) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="420"><rect width="100%" height="100%" fill="#f5f7fa"/>
      <rect x="40" y="40" width="820" height="340" rx="24" fill="#16a34a"/>
      ${lines.map((l, i) => `<text x="450" y="${170 + i * 110}" text-anchor="middle" font-family="DejaVu Sans, Arial" font-weight="700" font-size="${i ? 54 : 84}" fill="#ffffff">${l}</text>`).join('')}</svg>`;
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    await sharp(Buffer.from(svg)).png().toFile(p);
  }
}

async function generate(root, lang = 'tr') {
  const data = lang === 'tr' ? TR : EN;
  bulk(data, lang);
  write(root, data);
  await images(root, lang);
  return Object.keys(data).map((d) => path.join(root, d));
}

if (require.main === module) {
  const root = process.argv[2];
  const lang = process.argv[3] === 'en' ? 'en' : 'tr';
  if (!root) { console.error('Kullanım: node scripts/sample-data.js <hedef klasör> [tr|en]'); process.exit(1); }
  generate(root, lang).then(() => console.log(`örnek veri: ${root} (${lang})`));
}

module.exports = { TR, EN, write, bulk, generate };
