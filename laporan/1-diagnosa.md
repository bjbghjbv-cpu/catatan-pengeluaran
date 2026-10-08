# Laporan 1 — Diagnosa: Aplikasi Tidak Membaca Struk dengan Benar

- **Sub-Agent:** 1 (Detektif / Diagnosa) — READ-ONLY, tidak mengubah kode aplikasi.
- **Tanggal pemeriksaan:** 2026-10-08
- **Project:** `C:\Users\setia\OneDrive\ドキュメント\Default Project`
- **Metode utama:** Chrome headless via Chrome DevTools Protocol (CDP) — karena tool browser desktop tidak terhubung ke sesi ini (`browser.disconnected`). Aplikasi dijalankan sungguhan dari `http://localhost:8080`, gambar diunggah programatik ke `<input id="inputGallery">`, lalu DOM/console/`Vision.*` dibaca. Lihat `laporan/harness/`.

---

## 1. Foto struk yang dipakai (FOTO_STRUK)

| Item | Nilai |
|---|---|
| Path | `C:\Users\setia\Downloads\struk_contoh.jpeg` |
| Ukuran | 96.006 byte, **720 × 1280 px**, JPEG, 24bpp |
| Waktu modifikasi | **2026-10-08 20:48:32** |
| EXIF Orientation | **tidak ada tag** → orientation = 1 (tidak ada rotasi EXIF) |
| Isi | Struk EDC/pembayaran kartu BCA (**cardholder copy**) — bukan struk belanja ber-item |

## 2. Ground truth (dibaca langsung dari gambar)

| Field | Nilai benar |
|---|---|
| Merchant / brand | **GOOD FRIENDS-HD** (baris 1); **PACIFIC GARDEN SQUARE** (baris 2) |
| Alamat | GF NO 09-10 ALAM SUTERA |
| Merchant ID | 000885003004138 |
| Tanggal / jam | **08 OCT 26  14:51** → **2026-10-08** |
| Issuer / cardholder | BCA / SUN BERNAT SETIAWAN; kartu 0821\*\*\*\*85 |
| **TOTAL** | **Rp 77.000** → `77000` |
| Daftar item | **TIDAK ADA** (slip pembayaran kartu: DEBIT, BATCH 006974, TRACE NO 011523, REF.NO 62814013722, APPR CODE 145156, RRN QRIS 387270703, PAN# 9360001430030041385) |

---

## 3. Hasil reproduksi aplikasi (output nyata)

### 3a. Pipeline PRODUKSI (deteksi+warp OpenCV → OCR pada hasil warp)

Output diambil dari `#rawOcr`, form konfirmasi, `#quadOverlay`, `Vision.parseReceiptText` (`laporan/harness/app-probe.json`, `hasil-repro.json`).

- **Quad deteksi (dari `#quadOverlay`):** `26.39,21.48 76.39,36.02 63.06,66.95 15.83,66.33` (ternormalisasi 0–100)
  → dalam piksel 720×1280: **P1(190,275), P2(550,461), P3(454,857), P4(114,849)**.
  → Sisi atas P1→P2 miring **27,3°** ke bawah; **P2 mendarat ±180 px di bawah sudut kanan-atas struk yang sebenarnya (~590,285)**. Quad miring, bukan persegi di sekeliling struk. Lihat `laporan/harness/quad-overlay.jpg`.
- **Hasil warp:** hanya **405 × 579 px**, isi struk ikut miring/ter-shear.
- **`note`:** "Struk terdeteksi, diluruskan & dipotong otomatis."
- **`prepareForOcr(warp)`:** di-upscale ke **2000 × 2859 px** (≈4,9×) dengan smoothing.
- **OCR mentah (warp, `ind+eng`, PSM default):**
  ```
  FR Let
  fh SA)
  7 Neo -
  1 x A 4
  ...
  1 Y : > 1 L550
  v LY 1h oR 145
  ...
  ```
- **confidence (console):** `[pipeline] OCR selesai, panjang teks: 222 conf: 38`
- **Parsing:** merchant `"FR Let"`, tanggal `null`, total `null`, items `[{1 Y : > 1 L,550},{v LY 1h oR,145}]`.
- **Form yang tampil:** merchant `FR Let`, tanggal `2026-10-08` (⚠️ = fallback hari ini, bukan hasil parse), **total kosong**, kategori LAINNYA.

### 3b. Pembanding — OCR pada FOTO ASLI (setara "MODE CEPAT", tanpa warp)

Dijalankan via global `Vision.fileToCanvas` + `Vision.downscale(…,1800)` + `Vision.prepareForOcr` + `Vision.ocr` pada foto asli.

- `prepareForOcr`: 720×1280 → **2000 × 3556** (≈2,8×).
- **OCR mentah (conf 50, 25 baris) — jauh lebih baik:**
  ```
  GOOD FRIENDS HO
  AC GARDEN SQUARE
  GF NO 09-10 ALAN SUTERA
  RB TERM _A2FBY6L0) MERCH 000885003004138
  0821 +++ iga
  SUN BERNAT SETIAWAN
  Issuer: BCA
  BPAYMENT QR Bri/rane 08 UCI 26 14:51
  TOTAL \ Rp.77,000 :
  ... SIGNATURE NOT REGTIRED
  ```
- **Parsing:** **total = 77000 ✅**, merchant `"A Si"` ❌, tanggal `null` ❌, items 2 palsu.

### 3c. Tabel perbandingan

| Field | Ground truth | Aplikasi (produksi: warp) | Aplikasi (foto asli/mode cepat) |
|---|---|---|---|
| Merchant | **GOOD FRIENDS-HD** | `FR Let` ❌ | `A Si` ❌ (OCR memuat "GOOD FRIENDS HO") |
| Tanggal | **2026-10-08** | `null` ❌ (form tampil 2026-10-08 = *fallback hari ini*) | `null` ❌ |
| Total | **77000** | `null` ❌ (kosong) | **77000 ✅** |
| Items | tidak ada | 2 item palsu ❌ | 2 item palsu ❌ |
| Teks OCR | — | berantakan (222 char, conf 38) | sebagian besar benar (conf 50) |
| Deteksi/warp | — | quad SALAH (miring 27°) | (tidak dipakai) |

**Gejala persis:** Deteksi sudut struk salah (sudut kanan-atas jatuh di tengah sisi) → hasil warp miring 27° dan kecil (405×579) → OCR produksi menghasilkan **teks sampah**; akibatnya **merchant salah, total kosong, tanggal kosong** (ditutupi fallback tanggal hari ini), dan item palsu. Menariknya, **OCR pada foto asli menghasilkan teks yang jauh lebih baik dan total 77.000 benar** — jadi kerusakan utama terjadi di tahap computer-vision, bukan di Tesseract.

---

## 4. Akar penyebab (berperingkat, paling berpengaruh dulu)

### 🔴 #1 — Deteksi quad salah → warp memiringkan struk → OCR hancur (Keyakinan: TINGGI)
- **Lokasi:** `js/vision.js:509-593` (worker `processReceipt`), strategi 1 `js/vision.js:517-537` (Canny+`approxPolyDP`), cek `tallQuad` `js/vision.js:565`; padanan thread utama `js/vision.js:324-408` dan `js/vision.js:354` (eps 0.02/0.03/0.05).
- **Bukti:** quad `P1(190,275) P2(550,461) P3(454,857) P4(114,849)` — P2 ±180 px di bawah sudut asli; sisi atas miring 27,3° (`laporan/harness/quad-overlay.jpg`). Hasil warp 405×579 dengan teks diagonal. OCR warp = sampah, sedangkan OCR foto asli = benar. `tallQuad` hanya menguji `h ≥ w·1.05` (579 ≥ 425 ✔) sehingga quad miring tetap **lolos**.
- **Penyebab fisik:** struk kusut (sudut kanan-atas terlipat) + latar meja gelap/bertekstur + **kabel hitam tebal di sisi kiri** membuat kontur tepi tidak mengikuti sudut kertas. Tidak ada validasi "quad harus mendekati persegi panjang sejajar sumbu" maupun deskew.

### 🔴 #2 — OCR hanya pada hasil warp; tidak ada fallback/komparasi ke foto asli (Keyakinan: TINGGI)
- **Lokasi:** `js/main.js:595` `Vision.ocr(Vision.prepareForOcr(result.scan), …)`; "ronde 2" `js/main.js:621-642` hanya mem-biner-kan **scan yang sama** (`Vision.binarize(result.scan)`), bukan foto asli.
- **Bukti:** `result.scan` (405×579) → teks sampah; foto asli (`result` bila warp gagal / mode cepat) → total 77000 benar. Satu kegagalan CV meracuni seluruh pipeline; tidak ada pemilihan "sumber OCR terbaik" berbasis skor.

### 🔴 #3 — `matchDate()` tidak mengenal nama bulan Inggris → tanggal SELALU gagal untuk struk BCA (Keyakinan: TINGGI — terbukti)
- **Lokasi:** `js/vision.js:761` `BULAN_RE = '(jan|feb|mar|apr|mei|jun|jul|agu|agst|sep|okt|nov|des)…'` dan `js/vision.js:764-787` `matchDate`; fallback `js/main.js:714` `tanggal: p.tanggal || Utils.todayISO()`.
- **Bukti:** `Vision.matchDate("DATE/TIME 08 OCT 26 14:51")` → **`null`** (bulan "OCT" bukan "okt"; regex pertama butuh pemisah `[/-.]`). Jadi bahkan dengan OCR sempurna `2026-10-08` takkan terbaca. UI diam-diam mengisi `todayISO()` (hari ini 2026-10-08) sehingga **bug tersamarkan** — akun hanya benar karena kebetulan tanggal pemeriksaan = tanggal struk.
- **Dampak:** pada hari lain / struk lain, tanggal yang ditampilkan **salah**, dan user tak diberi peringatan.

### 🟠 #4 — `prepareForOcr()` melakukan upscale buta (tanpa sharpen/Otsu/deskew) di atas scan kecil (Keyakinan: TINGGI)
- **Lokasi:** `js/vision.js:306-317` (`targetW = 2000`, hanya `drawImage` dengan `imageSmoothingQuality='high'`), dipanggil `js/main.js:595`.
- **Bukti:** warp 405×579 → 2000×2859 (4,9×). Memperbesar gambar buram tidak menambah detail dan membuat Tesseract "berhalusinasi" (OCR warp: teks sampah; di lab `scan` 405 px langsung bahkan menghasilkan teks kosong). Tidak ada unsharp mask, normalisasi kontras, binarisasi Otsu, maupun estimasi sudut/deskew.

### 🟠 #5 — Parser item mengarang item palsu dari metadata struk EDC (Keyakinan: TINGGI — terbukti)
- **Lokasi:** `js/vision.js:886-901` (loop item + `skipItem`), batas harga `harga < 100` di `js/vision.js:897`; `Utils.parsePrice` `js/utils.js:44-70`.
- **Bukti:** pada teks ground-truth ideal sekalipun, `parseReceiptText` menghasilkan **7 item palsu**:
  `TERM A2FB 9600`, `MERCH 885003004138`, `BATCH : 6974`, `TRACE NO: 11523`, `REF.NO. 62814013722`, `APPR CODE 145156`, `PAN# 9360001430030041000`.
  `skipItem` tidak memuat `batch|trace|ref|appr|merch|pan|card|issuer`; tidak ada batas atas harga wajar; angka panjang (mis. nomor PAN/no. referensi) tetap diterima sebagai harga. Untuk struk EDC tanpa item, `items` seharusnya **kosong**.

### 🟡 #6 — `pickMerchant()` tidak andal (Keyakinan: SEDANG–TINGGI)
- **Lokasi:** `js/vision.js:820-850` (+ skor `merchantLineScore` `js/vision.js:802-812`, fallback berbasis tinggi huruf).
- **Bukti:** pada teks ideal → `PACIFIC GARDEN SQUARE` (bukan brand `GOOD FRIENDS-HD`); pada OCR foto asli → `A Si` / `ES ac GARDEN SQUARE`; pada warp → `FR Let`. Keputusan berbasis tinggi/posisi baris, bukan pola brand, dan tidak menyaring noise.

### 🟡 #7 — Konfigurasi Tesseract tanpa PSM / `preserve_interword_spaces` / `user_defined_dpi` (Keyakinan: SEDANG sebagai faktor pendukung, BUKAN penyebab utama)
- **Lokasi:** `js/vision.js:688` `T.recognize(canvas, 'ind+eng', { cacheMethod:'write', logger })`.
- **Bukti (lab `laporan/harness/ocr-lab.json`):** pada **foto asli** PSM 6 memulihkan `14:51`, `000885`, `TOTAL`, `PAYMENT`, `SUTERA`; PSM 3/4 memulihkan `GOOD FRIENDS`, `PACIFIC GARDEN SQUARE`, `77.000`. Artinya pilihan PSM memang mengubah hasil. **Namun** pada hasil warp, PSM 3/6/4 dan rotasi 90/270 **semuanya tetap sampah** → PSM tidak bisa menyelamatkan gambar yang salah/rotasi. Jadi ini optimisasi penting, bukan akar masalah utama.

### 🟡 #8 — Parameter worker vs thread-utama tidak konsisten (Keyakinan: SEDANG)
- **Lokasi:** worker `js/vision.js:465` `adaptiveThreshold(...,31,15)` & `minArea = totalArea*0.08` (`:523`) vs thread utama `js/vision.js:418` `adaptiveThreshold(...,41,18)` & `minArea = …*0.12` (`:348`); daftar `eps` berbeda (`:527` vs `:354`); worker punya strategi 2 "bright blob" + `tallQuad`, thread utama tidak.
- **Bukti:** kutipan kode di atas. Dua jalur memberi hasil berbeda untuk foto sama → sulit direproduksi & di-debug. (Pada pengujian ini jalur yang dipakai adalah **worker** karena `importScripts` OpenCV berhasil.)

### 🟡 #9 — Jumlah varian OCR minim; tanpa invert / eng-only / deskew/OSD (Keyakinan: SEDANG)
- **Lokasi:** `js/main.js:621-642` (hanya 2 ronde: CLAHE vs adaptif-bin dari scan yang sama); tak ada `tessedit_pageseg_mode`, `invert`, `eng` saja, rotasi, atau OSD.
- **Bukti:** kode; lab menunjukkan rotasi/preprocessing/P SM lain memang mengubah hasil, tetapi tidak dipakai aplikasi.

---

## 5. Rekomendasi perbaikan konkret

1. **Validasi quad & fallback deteksi (#1):** tolak quad yang tidak wajar (mis. sudut menyimpang > ~8–10° dari siku, atau rasio sisi terlalu janggal). Tambah strategi alternatif (mis. `minAreaRect` untuk sudut, atau gunakan `largestBrightBlob` lalu `boundingRect` tanpa warp bila quad meragukan). Pilih kandidat dengan skor "kepersegipanjangan" + area.
2. **Fallback sumber OCR (#2):** bila OCR pada warp kosong/berisik, OCR juga **foto asli** (dan/atau crop-asli), lalu pilih hasil terbaik dengan **skor gabungan** (confidence × jumlah kata valid × jumlah field terparse), bukan confidence mentah. Jangan hanya mem-biner ulang scan yang sama.
3. **Perbaiki `matchDate` (#3):** dukung nama bulan **Inggris** (JAN…DEC) selain Indonesia; terima format `08 OCT 26`, `08-OCT-26`, `OCT 08, 2026`; bila tanggal tak terbaca, **jangan** diam-diam isi `todayISO()` — tandai kosong/perlu konfirmasi.
4. **Preprocessing lebih kuat (#4):** usahakan sumber resolusi tinggi (jangan warp ke kanvas kecil); tambah **deskew** ringan (estimasi sudut teks/`minAreaRect`), **unsharp mask**, normalisasi kontras; siapkan beberapa varian (CLAHE, Otsu, adaptive, invert) dan pilih terbaik via skor.
5. **Perbaiki parser item (#5):** tambah kata kunci buang `batch|trace|ref|appr|merch|pan|nouc|card|issuer|rrn|tid|mid`; batasi harga wajar (mis. ≤ Rp 100.000.000) dan tolak string angka sangat panjang (no. referensi/PAN). Jika terdeteksi pola "struk kartu/EDC" (ada `DEBIT/KREDIT/QRIS/TRACE/PAN/APPR`), set `items = []`.
6. **Perbaiki `pickMerchant` (#6):** prioritaskan baris **paling atas** dengan huruf kapital kuat, buang baris junk/noise, dan pertimbangkan baris kedua sebagai alamat/venue; buang kandidat yang mirip noise OCR (mis. campuran simbol).
7. **Konfigurasi Tesseract (#7):** coba PSM `6` dan `4` (dan `11`) lalu pilih terbaik per gambar; set `preserve_interword_spaces='1'`, `user_defined_dpi='300'`; pertimbangkan `eng` saja untuk baris harga/angka.
8. **Samakan parameter worker vs utama (#8):** ekstrak satu implementasi kanonik (parameter & strategi sama) agar hasil konsisten.
9. **Tangani orientasi/miring (#9):** tambah deskew berbasis konten (bukan hanya EXIF) dan uji beberapa rotasi untuk struk miring/terbalik.

---

## 6. Cara menjalankan ulang reproduksi

```powershell
# 1. (jika belum) server lokal di root project
cd "C:\Users\setia\OneDrive\ドキュメント\Default Project"
python -m http.server 8080

# 2. Reproduksi pipeline produksi (warp) + pembanding foto asli (butuh internet utk OpenCV/Tesseract CDN)
node "laporan\harness\cdp-run.mjs"      # -> laporan/harness/hasil-repro.json + console.txt + scan-preview.jpg
node "laporan\harness\app-probe.mjs"    # -> laporan/harness/app-probe.json + quad/scan/upscale

# 3. Uji Tesseract & parsing tanpa CV
node "laporan\harness\ocr-lab.mjs"      # -> laporan/harness/ocr-lab.json  (rotasi/preprocessing/PSM)
node "laporan\harness\parse-probe.mjs"  # -> laporan/harness/parse-probe.json (matchDate + parseReceiptText)

# 4. Overlay quad (bukti visual) sudah tersimpan: laporan/harness/quad-overlay.jpg
```

Harness memakai Chrome headless + CDP (tanpa dependensi npm). Jika ingin manual: buka `http://localhost:8080`, klik "PILIH DARI GALERI", unggah `struk_contoh.jpeg`, tunggu tahap konfirmasi, lihat "LIHAT TEKS MENTAH OCR" dan isi form.

**Batas metode:** tool `browser` desktop tidak tersedia (disconnected); harness memakai Chrome headless sehingga tak ada interaksi visual, tetapi menjalankan **kode aplikasi asli yang sama** (termasuk worker OpenCV & Tesseract dari CDN). Nilai confidence dapat bervariasi kecil antar-jalankan.

---

## 7. Verdict atas hipotesis yang diminta

| Hipotesis | Verdict |
|---|---|
| `prepareForOcr()` hanya upscale+smoothing tanpa sharpen/deskew/Otsu | **TERBUKTI** (memperburuk, tapi akibat dari warp kecil) |
| Deteksi/warp salah pada meja bertekstur; param worker vs utama beda | **TERBUKTI** — quad salah & param beda |
| Tesseract tanpa PSM/preserve_interword_spaces/user_defined_dpi | **TERBUKTI** (ada, tapi bukan penyebab utama; PSM tak menyelamatkan warp) |
| Hanya 2 varian OCR; tanpa invert/eng-only/PSM beda | **TERBUKTI** |
| Parsing: total ambil angka terbesar; item kosong/merchant tertukar | **TERBUKTI** untuk item palsu & merchant; `total` justru benar pada foto asli |
| Orientasi: EXIF ditangani, tanpa deskew/OSD | **TERBUKTI** — EXIF tidak ada, tidak ada deskew |

**Kesimpulan utama:** masalah bukan (terutama) di Tesseract/parsing, melainkan **deteksi sudut struk yang salah pada foto kusut** yang memiringkan hasil warp, ditambah **tidak adanya fallback ke foto asli**. Perbaikan pada deteksi + pemilihan sumber OCR + `matchDate` (bulan Inggris) akan memberi lompatan terbesar.
