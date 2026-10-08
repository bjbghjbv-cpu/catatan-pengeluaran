Catatan Pengeluaran Bulanan — Expense Tracker dengan Pemindai Struk

> **Aplikasi web pencatat pengeluaran bulanan** berbahasa Indonesia dengan fitur utama **pemindaian struk dari kamera** — deteksi struk, pelurusan perspektif, dan pembacaan teks (OCR) berjalan **sepenuhnya di perangkat** (tanpa API key, tanpa upload).

**Gaya visual:** editorial monokrom ala studio kreatif *ownitt* — hitam pekat `#0B0B0B`, krem gading `#F1EEE7`, aksen hijau limau `#C9F24D`, tipografi Anton / Playfair Display italic / Inter.

---

## ✨ Fitur Utama

| Kategori | Fitur |
|----------|-------|
| **📷 Input Kamera & Galeri** | • Kamera live di dalam aplikasi (getUserMedia + tombol bidik)<br>• Tombol **AMBIL FOTO** → langsung buka kamera belakang HP (`capture="environment"`)<br>• Pilih dari galeri (JPG/PNG/PDF) & **drag & drop**<br>• Orientasi foto diperbaiki otomatis (metadata EXIF) |
| **🧠 Computer Vision + OCR (Offline-First)** | • **OpenCV.js**: grayscale → Gaussian blur → CLAHE → Canny → kontur → `approxPolyDP` (4 sudut) → **auto-crop + koreksi perspektif**<br>• **Tesseract.js 5** bahasa **Indonesia + Inggris** (`ind+eng`)<br>• Parsing otomatis: **toko, tanggal, item + harga, total**<br>• Perbandingan "foto asli vs hasil scan" + garis limau area struk terdeteksi<br>• Hasil bisa **dikoreksi manual** sebelum disimpan; fallback manual bila OCR gagal<br>• **Validasi geometri quad** — tolak warp miring, fallback ke crop/foto asli |
| **📒 Pencatatan Transaksi** | • Tanggal, kategori (chip/pill), toko, total, rincian item<br>• Tambah / edit / hapus manual |
| **📊 Ringkasan Bulanan** | • Total pengeluaran, grafik batang horizontal per kategori + persentase<br>• Segmen limau untuk kategori terbesar<br>• Navigasi bulan `< OKTOBER 2026 >` |
| **💾 Data Lokal & Ekspor** | • **localStorage** (tetap ada setelah ditutup browser)<br>• **Ekspor/Impor CSV & JSON** (backup & pindah perangkat) |
| **☁️ Mode Cloud Vision (Opsional)** | • Google Cloud Vision API / Azure Computer Vision<br>• Tanpa API key aplikasi tetap berfungsi penuh (Tesseract lokal) |

---

## 📦 Library / Dependensi (CDN — Tanpa Install)

Aplikasi ini **murni HTML + CSS + JavaScript** — **tidak ada `npm install`, tidak ada build step, tidak ada bundler**. Semua library dimuat via CDN saat dibuka di browser.

| Library | Versi | Sumber CDN | Fungsi |
|---------|-------|------------|--------|
| **OpenCV.js** | 4.x | `https://docs.opencv.org/4.x/opencv.js` | Computer vision: preprocessing, deteksi tepi, kontur, warp perspektif, CLAHE, thresholding |
| **Tesseract.js** | 5.x | `https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js` | OCR client-side (bahasa `ind+eng`), web worker, cache `traineddata` |
| **PDF.js** | 3.11.174 | `https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js` | Render halaman pertama PDF ke canvas (untuk struk PDF) |
| **PDF.js Worker** | 3.11.174 | `https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js` | Web worker untuk parsing PDF |
| **Google Fonts** | — | `https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700&family=Playfair+Display:ital,wght@1,400;1,600&display=swap` | Tipografi: Anton (display), Inter (UI), Playfair Display Italic (aksen) |

> **Catatan:** Saat **pertama kali dibuka**, browser akan mengunduh ~10 MB (OpenCV.js WASM) + model Tesseract (`ind.traineddata`, `eng.traineddata`). Setelah tersimpan di **Cache Storage / IndexedDB**, pemakaian berikutnya **offline & cepat**.

---

## 🖥️ Persyaratan Sistem

| Kebutuhan | Minimum | Direkomendasikan |
|-----------|---------|------------------|
| **Browser** | Chrome 88+, Firefox 78+, Edge 88+, Safari 14+ | Chrome/Edge terbaru (WebAssembly SIMD, SharedArrayBuffer) |
| **OS** | Windows 10, macOS 11, Linux, Android 10, iOS 14 | — |
| **Kamera** | 720p, autofokus | 1080p+, autofokus cepat, cahaya rendah baik |
| **RAM** | 2 GB | 4 GB+ (WebAssembly + OCR butuh memori) |
| **Jaringan** | Hanya saat **pertama kali** (download library) | — |
| **HTTPS / localhost** | **Wajib** untuk kamera live (`getUserMedia`) | Gunakan `http://localhost:8080` atau HTTPS di hosting |

---

## ⚙️ Instalasi & Menjalankan

Karena **tidak ada build step**, cukup salin folder project ke mana saja dan jalankan server statis.

### Opsi A — Server Lokal (Disarankan ✅)

Semua fitur (termasuk kamera live) bekerja penuh.

```bash
# Python 3 (sudah terpasang di sebagian besar sistem)
python -m http.server 8080

# Atau Node.js (npx serve)
npx serve .

# Atau PHP
php -S localhost:8080
```

Lalu buka **http://localhost:8080** di browser.

> **VS Code:** Klik kanan `index.html` → **Open with Live Server** (ekstensi *Live Server*).

### Opsi B — Buka Langsung (Tanpa Server)

```bash
# Klik dua kali index.html (atau drag ke browser)
# Protokol: file://
```

| Fitur | `file://` | `http://localhost` / HTTPS |
|-------|-----------|----------------------------|
| Pencatatan manual | ✅ | ✅ |
| OCR (Tesseract) | ✅ | ✅ |
| Computer Vision (OpenCV) | ✅ | ✅ |
| Penyimpanan localStorage | ✅ | ✅ |
| **Kamera live (getUserMedia)** | ❌ (blokir browser) | ✅ |
| **Tombol AMBIL FOTO** (`capture="environment"`) | ✅ (buka kamera native) | ✅ |
| Pilih dari galeri / drag-drop | ✅ | ✅ |

> **Kesimpulan:** Untuk HP / kamera live penuh → **pakai Opsi A**. Untuk cepat coba OCR dari file → Opsi B cukup.

### Opsi C — Deploy ke Hosting Statis

Salin semua file ke: **Netlify**, **Vercel**, **GitHub Pages**, **Cloudflare Pages**, **Firebase Hosting**, dll.

**Wajib:** HTTPS (karena kamera). Semua hosting modern otomatis kasih HTTPS.

---

## 🎮 Cara Pakai (Panduan Lengkap)

### 1. Persiapan Pertama Kali
1. Buka `http://localhost:8080` (atau hosting Anda)
2. Tunggu indikator "Memuat OpenCV..." & "Memuat Tesseract..." selesai (hanya sekali)
3. Izinkan akses kamera jika diminta

### 2. Memindai Struk (Foto/Scan)

| Metode | Langkah |
|--------|---------|
| **Kamera Live (Desktop/HP)** | Klik **AMBIL FOTO** → izinkan kamera → bidik struk → **BIDIK** |
| **Kamera Native HP** | Klik **AMBIL FOTO** → pilih "Kamera" → foto struk → **Gunakan Foto** |
| **Galeri / File** | Klik **PILIH DARI GALERI** → pilih JPG/PNG/PDF |
| **Drag & Drop** | Tarik file gambar/PDF ke area halaman |

> **Tips foto bagus:** Cahaya cukup, struk rata (tidak terlalu kusut), latar kontras (meja gelap untuk struk putih), seluruh struk masuk frame.

### 3. Proses Otomatis
```
MENDETEKSI STRUK → MEMBACA STRUK (OCR) → HASIL SIAP DIPERIKSA
```
- **Deteksi:** OpenCV cari 4 sudut struk → auto-crop & luruskan (warp perspective)
- **Validasi:** Quad miring >10° ditolak → pakai crop tegak / foto asli
- **OCR:** Tesseract baca teks (ind+eng) → confidence & layout lines
- **Parsing:** Regex ekstrak toko, tanggal, item+harga, total
- **Fallback:** Jika confidence < 70 / teks pendek → baca ulang versi biner (adaptive threshold)

### 4. Konfirmasi & Simpan
Di form konfirmasi, periksa & koreksi:
- **Toko** (merchant) — nama toko/brand
- **Tanggal** — format `YYYY-MM-DD` (otomatis dari OCR)
- **Item** — daftar nama + harga (bisa tambah/hapus/edit)
- **Total** — otomatis dari OCR, bisa diubah manual
- **Kategori** — pilih chip: 🍔 Makanan, 🚌 Transportasi, 🛒 Belanja, 🏥 Kesehatan, 📦 Lainnya

Klik **SIMPAN** → transaksi masuk daftar bulan berjalan.

### 5. Kelola Transaksi (Tab DAFTAR)
- Lihat semua transaksi bulan ini
- Klik baris → **Edit** (ubah toko, tanggal, item, total, kategori) / **Hapus**
- Total bulanan terhitung otomatis

### 6. Ringkasan & Ekspor (Tab RINGKASAN)
- Grafik batang horizontal per kategori + persentase
- Navigasi bulan `< SEPT 2026 >` `< OKT 2026 >` `< NOV 2026 >`
- **EKSPOR CSV** → buka di Excel/Sheets
- **EKSPOR JSON** → backup lengkap (bisa diimpor ke perangkat lain)
- **IMPOR** → pilih file JSON → data digabung (dedup by ID)
- **MODE OCR CLOUD** → masukkan API key Google/Azure (opsional)

---

## 🗂️ Struktur Project

```
project-struk/
├── index.html          # Entry point: 3 layar (Beranda/Daftar/Ringkasan) + modal + overlay
├── README.md           # Dokumentasi ini
├── css/
│   └── style.css       # Seluruh desain: palet, tipografi, komponen, animasi, responsive
├── js/
│   ├── utils.js        # Format rupiah/tanggal, parsing harga, CSV export/import, download
│   ├── store.js        # localStorage CRUD: transaksi, settings, kategori
│   ├── vision.js       # Pipeline CV + OCR:
│   │                    # - loadOpenCV / loadTesseract / loadPdfJs (lazy, once)
│   │                    # - fileToCanvas (EXIF orientation fix, PDF support)
│   │                    # - downscale / prepareForOcr / binarize
│   │                    # - detectAndWarp (thread utama) + worker (buildWorkerSource)
│   │                    # - cvFindReceiptQuad / cvQuadSane (validasi geometri)
│   │                    # - ocrBest (multi-sumber: warp/crop + foto asli + biner, skor field)
│   │                    # - tesseractOcr (PSM 4/6, preserve_interword_spaces, DPI 300)
│   │                    # - googleOcr / azureOcr (cloud opsional)
│   │                    # - parseReceiptText / matchDate / pickMerchant (parsing)
│   └── main.js         # Logika aplikasi:
│                        # - render 3 tab + modal + overlay
│                        # - kamera (getUserMedia + capture) / galeri / drag-drop
│                        # - runPipeline (CV → OCR → parse → confirm)
│                        # - form konfirmasi (edit item, kategori, simpan)
│                        # - ekspor/impor CSV & JSON
│                        # - settings cloud vision
└── laporan/            # (Hasil debug internal: diagnosa, perbaikan, verifikasi OCR)
    ├── 1-diagnosa.md
    ├── 2-perbaikan.md
    ├── 3-verifikasi.md
    ├── RINGKASAN.md
    └── harness/        # Skrip otomatisasi uji (Chrome headless + CDP)
```

---

## ⚙️ Konfigurasi & Kustomisasi

### Variabel Utama (js/vision.js — bagian atas)

| Variabel | Default | Kegunaan |
|----------|---------|----------|
| `OPENCV_URL` | CDN OpenCV 4.x | Ganti ke lokal / mirror lain jika perlu offline total |
| `TESSERACT_URL` | CDN Tesseract 5 | Sama |
| `PDFJS_URL` / `PDFJS_WORKER` | CDN PDF.js 3.11 | Sama |
| `RANGE_X` / `RANGE_Y` | (di main.js) | Bukan di vision.js — lihat main.js untuk kamera |

### Variabel Utama (js/main.js — bagian atas)

| Variabel | Default | Kegunaan |
|----------|---------|----------|
| `fastMode` | `false` | `true` = lewati CV, OCR langsung foto asli (lebih cepat, kurang akurat untuk struk miring) |
| `captureToken` | — | Token untuk membatalkan pipeline lama saat foto baru |

### Pengaturan Pengguna (di Tab RINGKASAN → ⚙️)

| Setting | Deskripsi |
|---------|-----------|
| **MODE OCR CLOUD** | Pilih: `None` (default, Tesseract lokal) / `Google Cloud Vision` / `Azure Computer Vision` |
| **Google API Key** | API Key project GCP dengan Cloud Vision API aktif |
| **Azure Endpoint** | Contoh: `https://namasumber.cognitiveservices.azure.com` |
| **Azure Key** | Key Cognitive Services |

> Settings tersimpan di `localStorage` → tetap ada setelah reload.

---

## 🐛 Troubleshooting

| Masalah | Penyebab & Solusi |
|---------|-------------------|
| **Kamera tidak muncul / error `NotAllowedError`** | Browser blokir `getUserMedia` di `file://` atau non-HTTPS. → Pakai `http://localhost:8080` atau HTTPS. Izinkan kamera di pengaturan browser (🔒 di address bar). |
| **Kamera hitam / hijau / tidak fokus** | Tutup aplikasi lain yg pakai kamera (Zoom, Meet, dll). Coba refresh. HP: bersihkan lensa. |
| **OCR lambat (>30 detik)** | Struk panjang / HP lama. Normal: Tesseract di browser single-thread. Coba **Mode Cepat** (RINGKASAN → setelan) atau foto lebih jelas. |
| **Hasil OCR salah total / item** | Struk kusut, gelap, miring, latar bertekstur. → Coba: (1) Foto lebih terang & lurus, (2) Mode Cepat, (3) Koreksi manual di form konfirmasi. |
| **Tanggal tidak terbaca (format Inggris `OCT`)** | Sudah diperbaiki: `matchDate` kini kenal bulan Inggris (JAN–DEC) + fuzzy `UCI`→`OCT`. Masih gagal? Koreksi manual. |
| **Item palsu muncul (metadata EDC/BCA)** | Sudah diperbaikan: parser deteksi pola EDC (`TRACE`, `PAN`, `APPR`, `BATCH`, `SIGNATURE NOT REQUIRED`) → `items = []` otomatis. |
| **Struk tidak terdeteksi (quad tidak muncul)** | Latar terlalu ramai / struk terpotong. → Gunakan latar polos kontras, pastikan seluruh struk dalam frame. Atau pakai **Mode Cepat** (lewati deteksi). |
| **Data hilang setelah ganti browser/HP** | Data di `localStorage` per browser/perangkat. → **EKSPOR JSON** di perangkat lama → **IMPOR** di perangkat baru. |
| **`OpenCV.js` / `Tesseract.js` gagal load** | Cek koneksi internet (hanya pertama kali). Cek console (F12) error CORS/CSP. Coba reload. |
| **PDF tidak bisa dibaca** | Hanya halaman pertama yg diproses. Pastikan PDF bukan scan gambar tanpa text layer (PDF.js render ke canvas → OCR tetap jalan). |

---

## 🔧 Perbaikan Terbaru (v2.x — Oktober 2026)

Ringkasan perbaikan pipeline OCR (detail di `laporan/`):

| # | Masalah | Solusi |
|---|---------|--------|
| 1 | **Quad deteksi miring 27° → warp hancurkan OCR** | Validasi geometri `cvQuadSane`: tolak quad miring >10°, fallback crop tegak / foto asli |
| 2 | **OCR hanya pakai hasil warp** | `ocrBest()`: multi-sumber (warp/crop + foto asli + biner), pilih **skor field** (conf × panjang teks × field terparse) |
| 3 | **`matchDate` tidak kenal bulan Inggris (`OCT`)** | Regex + map `JAN–DEC` + fuzzy correction (`UCI`→`OCT`) |
| 4 | **Parser item mengarang dari metadata EDC** | `skipItem` tambah `batch|trace|ref|appr|merch|pan|card|issuer|rrn|tid|mid`; deteksi pola EDC → `items=[]`; batas harga 100–100jt; tolak angka ≥12 digit |
| 5 | **Tesseract tanpa PSM/DPI** | PSM 4 & 6 (pilih terbaik), `preserve_interword_spaces=1`, `user_defined_dpi=300` |
| 6 | **Worker vs thread utama parameter beda** | Logika CV diekstrak ke fungsi `cv*` → di-`toString()` ke worker → **identik** |

---

## 🤝 Kontribusi

1. Fork repo
2. Buat branch: `git checkout -b fitur-baru`
3. Commit: `git commit -m "Tambah fitur X"`
4. Push: `git push origin fitur-baru`
5. Buat Pull Request

**Area yang butuh bantuan:**
- Tambah bahasa OCR (Jawa, Sunda, dll via `tessdata`)
- Improve `pickMerchant` dengan fuzzy matching brand toko Indonesia
- Deskew/OSD untuk struk miring/terbalik tanpa EXIF
- Service Worker untuk cache OpenCV/Tesseract offline total
- Unit test (Jest + jsdom) untuk parsing & CV logic

---

## 📄 Lisensi

**MIT License** — bebas gunakan, modifikasi, distribusi, komersialkan.

---

## 🙏 Acknowledgments

| Project | Peran |
|---------|-------|
| **OpenCV.js** | Computer vision di browser (WASM) |
| **Tesseract.js** | OCR client-side (Emscripten port) |
| **PDF.js** | Render PDF ke canvas (Mozilla) |
| **Google Fonts** | Tipografi gratis (Anton, Inter, Playfair Display) |
| **ownitt studio** | Inspiras desain editorial monokrom |

---

## 📞 Dukungan & Kontak

- **Issues:** [GitHub Issues](https://github.com/bjbghjbv-cpu/project-struk/issues) (jika repo dipublikasikan)
- **Email:** [tambahkan email Anda]
- **Diskusi:** [GitHub Discussions](https://github.com/bjbghjbv-cpu/project-struk/discussions)

---

> **Catatan Pengeluaran Bulanan** — Pencatat pengeluaran yang menghormati privasi: **data Anda tidak keluar dari perangkat**. 🌿📊
