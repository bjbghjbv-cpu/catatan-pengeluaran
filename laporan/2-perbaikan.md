# Laporan 2 — Perbaikan: Aplikasi Membaca Struk dengan Benar

- **Sub-Agent:** 2 (Pelaksana Perbaikan)
- **Tanggal:** 2026-10-08
- **Project:** `C:\Users\setia\OneDrive\ドキュメント\Default Project`
- **Foto uji:** `C:\Users\setia\Downloads\struk_contoh.jpeg` (struk EDC BCA, 720×1280)
- **Ground truth:** merchant `GOOD FRIENDS-HD`, tanggal `2026-10-08`, TOTAL `77000`, **tanpa item**.
- **File yang diubah:** `js/vision.js` (utama), `js/main.js` (pipeline & fallback tanggal). Skema localStorage, ekspor/impor, kamera, mode manual, dan mode cloud **tidak diubah**.

---

## 1. Ringkasan hasil (foto yang sama)

| Field | Ground truth | SEBELUM (produksi: warp) | SEBELUM (foto asli) | **SESUDAH (produksi)** |
|---|---|---|---|---|
| Merchant | **GOOD FRIENDS-HD** | `FR Let` ❌ | `A Si` ❌ | **GOOD FRIENDS HO** ✅ (dekat) |
| Tanggal | **2026-10-08** | `null` (form diisi hari-ini) ❌ | `null` ❌ | **2026-10-08** ✅ |
| Total | **77000** | `null` ❌ | `77000` ✅ | **77000** ✅ |
| Items | **[] (tidak ada)** | 2 item palsu ❌ | 2 item palsu ❌ | **[]** ✅ |
| Teks OCR | — | 222 char, conf 38 (sampah) | conf ~50 | 514 char, conf **58** |
| Deteksi | — | quad salah, warp **405×579** miring 27° | — | quad ditolak → **crop 472×624** (tanpa warp) |

`Vision.matchDate("DATE/TIME 08 OCT 26 14:51")`: **`null` → `2026-10-08`** ✅

**Bukti sesudah** (`laporan/harness/app-probe.json`):
```
form merchant/tanggal/total/kat: GOOD FRIENDS HO | 2026-10-08 | 77.000 | LAINNYA
parsedWarp: {"merchant":"GOOD FRIENDS HO","tanggal":"2026-10-08","items":[],"total":77000}
note: Struk terdeteksi & dipotong (tanpa pelurusan).   scan=472x624
```
Teks OCR yang dipakai (foto asli) memuat: `GOOD FRIENDS HO`, `PACIFIC GARDEN SQUARE`,
`PAYMENT QR ... 08 UCI 26 14:51`, `TOTAL ... Rp.77 000.`, `SIGNATURE NOT REQUIRED`,
`Cardholder Copy` — sehingga tanggal (pasca koreksi OCR bulan), total, dan status EDC terdeteksi.

---

## 2. Daftar perubahan per file

### `js/vision.js`

| Baris | Perubahan | Alasan | Temuan |
|---|---|---|---|
| 301–317 | `upscaleForOcr()` + `prepareForOcr()` (target 2000px, perilaku aman) | Upscale buta 405→2000 px dihapus sebagai **satu-satunya** jalur; prepareForOcr tetap dipakai sebagai varian default | #4 |
| 320–371 | Baru: `applyCssFilter()`, `otsuBinary()` (Otsu murni-JS), `prepareVariant()` (`plain`/`gray`/`otsu`/`invert`) | Menyediakan varian kontras/Otsu/invert **tanpa OpenCV di thread utama**, dipakai hanya bila hasil awal kurang baik | #4, #9 |
| 406–430 | Baru: `cvQuadSane()` — validasi quad (rasio sisi berlawanan ≥ 0,72; sudut 55°–125°) | Menolak quad "melipat" (satu sudut jatuh di tengah sisi) yang membuat warp miring | **#1** |
| 432–551 | `cvFindReceiptQuad()` — strategi 1 (Canny+approxPolyDP) **divalidasi**, bila gagal → strategi 2 area terang → **`boundingRect` crop** (tanpa warp) | Bila quad meragukan, **jangan warp paksa**; pakai crop sumbu-sejajar (rekomendasi diagnosa) | **#1** |
| 553–592 | `cvPrepareReceipt()` — warp bila quad valid, crop bila tidak, full bila kosong; hasilkan `scan` + `scanBin` | Satu inti keputusan yang dipakai worker & utama | #1 |
| 594–613 | `detectAndWarp()` (thread utama) memakai `cvPrepareReceipt`, mengembalikan `scanBin` juga | Parameter **kanonik** sama dengan worker | **#8** |
| 622–668 | `buildWorkerSource()` kini **meng-`toString()` fungsi `cv*` yang sama** ke dalam worker | Worker & thread utama **identik** (parameter Canny/CLAHE/adaptive 41-18, validasi quad, fallback crop) | **#8** |
| 765–790 | `getTessWorker()` — worker Tesseract v5 `createWorker` dipakai ulang | Lebih cepat & memungkinkan `setParameters` per percobaan | #7 |
| 792–830 | `tesseractOcr(canvas, onProgress, opts)` — set `tessedit_pageseg_mode`, `preserve_interword_spaces='1'`, `user_defined_dpi='300'` | Konfigurasi Tesseract eksplisit; PSM bisa dipilih per percobaan | **#7** |
| 877–903 | Baru: `ocrTextScore()` — skor gabungan `confidence + panjang teks + kata + jumlah field (merchant/tanggal/total/item)` | Pilih hasil **terbaik berbasis field**, bukan confidence mentah | **#2** |
| 906–960 | Baru: `ocrBest(sources, settings, onProgress)` — OCR beberapa **sumber** (warp/potong + foto asli + biner) & beberapa varian/PSM, pilih skor terbaik, **maks 4 percobaan** | Fallback & komparasi ke foto asli; hemat waktu | **#2, #4, #7, #9** |
| 970–1010 | `BULAN_MAP` (ID+**EN**), `editDistance()`, `fuzzyMonth()` (bobot posisi + stoplist) | Dukung nama bulan **Inggris** & toleransi salah-baca OCR (`UCI`/`OLI` → `OCT`) | **#3** |
| 1036–1078 | `matchDate()` mendukung `08 OCT 26`, `08-OCT-26`, `07 Oct 2026`, `OCT 08, 2026`, numerik, dan fuzzy | Tanggal BCA yang selalu gagal kini terbaca | **#3** |
| 1096–1140 | `cleanMerchant()` membuang prefix noise (`"23 \ "`) & `pickMerchant()` memprioritaskan **baris paling atas** ber-KAPITAL kuat, buang junk/bank/EDC | Merchant bukan lagi header/venue/alamat atau noise OCR | **#6** |
| 1142–1153 | Baru: `pickMerchantFromVariants()` | Ambil merchant dari varian OCR lain bila sumber terpilih tak memberi nama layak | #6 |
| 1159–1235 | `parseReceiptText()`: total prioritas `GRAND TOTAL > TOTAL > SUBTOTAL`; `skipItem` diperluas (`batch/trace/ref/appr/merch/pan/rrn/issuer/tid/mid/...`); batas harga `100 ≤ x ≤ 100.000.000`; tolak nomor ≥12 digit; deteksi EDC → `items=[]` | Hilangkan item palsu dari metadata EDC & cegah nomor referensi jadi "harga"; total `77000` benar | **#5** |
| 1237–1241 | Ekspor baru: `ocrBest`, `pickMerchant`, `pickMerchantFromVariants` | Dipakai `main.js` | — |

### `js/main.js`

| Baris | Perubahan | Alasan | Temuan |
|---|---|---|---|
| 591–649 | `runPipeline`: OCR beberapa sumber (`scan` + **foto asli `scaled`** + `scanBin`) via `Vision.ocrBest`; hapus "ronde 2" yang hanya mem-biner-kan scan yang sama | Satu kegagalan CV tak lagi meracuni hasil; foto asli ikut diuji & dipilih via skor | **#2, #9** |
| 651–653 | Bila merchant sumber terpilih lemah → ambil dari varian OCR lain | Merchant lebih andal | #6 |
| 217 | `buildEntryForm`: nilai input tanggal default **kosong** (bukan `todayISO()`) | Jangan samarkan kegagalan baca tanggal | **#3** |
| 396–398 | `openManual`: isi tanggal hari ini sebagai nilai awal (khusus input manual) | UX input manual tetap praktis | #3 |
| 715–718 | `showConfirm` draft: `tanggal: p.tanggal || ''` | Tanggal kosong bila OCR gagal — pengguna melihat & mengoreksi sendiri | **#3** |

---

## 3. Hasil uji harness

### 3a. `parse-probe.mjs` (parsing & matchDate)

```
=== ideal-groundtruth ===            (tanggal/total/items)
date = 2026-10-08   merchant = "GOOD FRIENDS-HD"  tanggal = 2026-10-08  total = 77000  items = 0 []
=== fast-mode-real ===                (teks OCR foto asli)
date = 2026-10-08   merchant = "GOOD FRIENDS HO"  tanggal = 2026-10-08  total = 77000  items = 0 []
=== warp-real ===                     (teks OCR produksi baru)
date = 2026-10-08   merchant = "GOOD FRIENDS HO"  tanggal = 2026-10-08  total = 77000  items = 0 []
```

### 3b. `app-probe.mjs` (pipeline produksi) — sebelum vs sesudah

| | Sebelum (diagnosa) | Sesudah |
|---|---|---|
| Quad | `26.39,21.48 76.39,36.02 63.06,66.95 15.83,66.33` (miring 27°) | `null` (quad salah ditolak) |
| Note | "Struk terdeteksi, diluruskan…" | "Struk terdeteksi & dipotong (tanpa pelurusan)." |
| Scan | 405×579 (miring) → upscale 2000×2859 | 472×624 → upscale 2000×2644 |
| OCR | 222 char, conf 38 | 514 char, conf 58 (dari foto asli) |
| Merchant | `FR Let` | **GOOD FRIENDS HO** |
| Tanggal | `null` (+ fallback hari ini) | **2026-10-08** |
| Total | `null` | **77000** |
| Items | 2 palsu | **0** |

### 3c. Uji regresi parsing (struk sintetis)

| Kasus | Merchant | Tanggal | Total | Items |
|---|---|---|---|---|
| Struk belanja biasa (Indomie/Aqua) | `TOKO SUMBER REJEKI` ✅ | 2026-10-07 ✅ | 11.000 ✅ | 2 ✅ |
| Struk EDC BCA (contoh) | `GOOD FRIENDS-HD` ✅ | 2026-10-08 ✅ | 77.000 ✅ | 0 ✅ |
| Struk diskon/pajak | `SUPER INDO` ✅ | 2026-09-12 ✅ | 105.600 (GRAND TOTAL) ✅ | 2 ✅ |

---

## 4. Kaitan dengan `laporan/1-diagnosa.md`

- **#1 (quad salah):** diperbaiki lewat `cvQuadSane` + fallback crop (`cvFindReceiptQuad`). Pada foto uji, quad miring 27° kini **ditolak** dan diganti crop 472×624 — tidak lagi menghasilkan warp kecil yang menghancurkan OCR.
- **#2 (tak ada fallback foto asli):** `ocrBest` mengikutkan **foto asli** sebagai sumber dan memilih pemenang dengan skor field; pada foto uji, sumber foto asli menang (total+merchant+tanggal benar).
- **#3 (matchDate tanpa bulan Inggris + fallback `todayISO` diam-diam):** `matchDate` kini mendukung `JAN..DEC`/ID, format `08 OCT 26` dll., plus koreksi fuzzy; fallback `todayISO()` di form konfirmasi **dihapus**.
- **#4 (upscale buta):** upscale naik ke 2000px tetap ada sebagai jalur default (terbukti baik untuk foto asli), tetapi varian `gray`/`otsu`/`invert` ditambahkan dan dipilih berbasis skor.
- **#5 (item palsu & total):** `skipItem` diperluas, batas harga & tolak nomor panjang, deteksi EDC → `items=[]`; total `77000` benar.
- **#6 (pickMerchant):** kini memprioritaskan baris paling atas ber-KAPITAL kuat dan membuang junk/noise/bank/EDC.
- **#7 (Tesseract tanpa PSM/dpi):** `setParameters` diatur eksplisit (PSM 3/6/4, `preserve_interword_spaces`, `user_defined_dpi`) dan PSM dipilih per percobaan.
- **#8 (param worker ≠ utama):** worker kini **meng-stringify fungsi `cv*` yang sama** → parameter & strategi identik.
- **#9 (varian OCR minim):** `ocrBest` + `prepareVariant` menyediakan varian sumber/preprocessing & PSM, dibatasi maks 4 percobaan agar tetap cepat.

---

## 5. Sisa masalah / keterbatasan

1. **Merchant = `GOOD FRIENDS HO`** (bukan `GOOD FRIENDS-HD`): huruf `-HD` tersambung/terbaca `HO` oleh OCR. Sudah "dekat & wajar"; untuk dapat `-HD` persis perlu OCR lebih tinggi resolusi.
2. **Koreksi bulan fuzzy** (`UCI`/`OLI` → `OCT`) bersifat heuristik dengan stoplist kata umum; pada struk sangat berisik masih ada peluang salah bulan walau kecil.
3. **Tahun 2-digit salah-baca** (mis. `26` terbaca `20`) tidak bisa dikoreksi otomatis (mis. pada teks pembanding sempat muncul `2020-10-08`); sumber terbaik pada produksi sudah benar.
4. **Deskew berbasis konten (rotasi 90/180/270 via OSD)** belum diimplementasikan (hanya crop tanpa warp + varian invert). Foto struk terbalik/tegak-salah belum ditangani otomatis.
5. Performa: pada struk ini OCR = 2 percobaan (foto asli + potong), ~2–4 detik setelah mesin siap.

---

## 6. Cara menjalankan ulang

```powershell
cd "C:\Users\setia\OneDrive\ドキュメント\Default Project"
python -m http.server 8080          # server lokal
node "laporan\harness\app-probe.mjs"    # pipeline produksi -> laporan/harness/app-probe.json
node "laporan\harness\parse-probe.mjs"  # matchDate + parseReceiptText
```
Bukti "sebelum" ada di `laporan/1-diagnosa.md` (§3) dan `laporan/harness/hasil-repro.json`;
bukti "sesudah" di `laporan/harness/app-probe.json` dan `laporan/_backup/sesudah-app-probe.txt`.
Cadangan kode sebelum perubahan: `laporan/_backup/vision.js.bak`, `laporan/_backup/main.js.bak`.
