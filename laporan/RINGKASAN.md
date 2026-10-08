# RINGKASAN — Perbaikan Pembacaan Struk (OCR) via 3 Sub-Agent

> **Project:** Catatan Pengeluaran Bulanan (web pemindai struk)  
> **Root:** `C:\Users\setia\OneDrive\ドキュメント\Default Project`  
> **Tanggal:** 2026-10-08

---

## 1. Masalah Awal

Pengguna melaporkan: **"Project tidak bisa membaca struk yang saya berikan dengan benar."**

Foto uji: `C:\Users\setia\Downloads\struk_contoh.jpeg` — struk **EDC/pembayaran kartu BCA** (cardholder copy), **bukan struk belanja ber-item**.

| Ground Truth | Aplikasi (sebelum perbaikan) |
|---|---|
| Merchant: **GOOD FRIENDS-HD** / PACIFIC GARDEN SQUARE | `FR Let` ❌ |
| Tanggal: **08 OCT 26** → **2026-10-08** | `null` (UI isi fallback hari ini) ❌ |
| Total: **Rp 77.000** (77000) | Kosong ❌ |
| Items: **Tidak ada** | 2 item palsu (metadata EDC) ❌ |

---

## 2. Akar Penyebab Utama (ditemukan Sub-Agent 1)

| # | Akar Penyebab | Keyakinan |
|---|---|---|
| 1 | **Deteksi quad salah** → warp memiringkan struk 27° → OCR hancur (`vision.js:509-593`) | 🔴 Tinggi |
| 2 | **OCR hanya pada hasil warp**; tidak ada fallback ke foto asli (`main.js:595,621-642`) | 🔴 Tinggi |
| 3 | **`matchDate()` tidak kenal bulan Inggris** ("OCT") → tanggal selalu gagal; fallback `todayISO()` menyamarkan bug (`vision.js:761-787`) | 🔴 Tinggi |
| 4 | `prepareForOcr()` upscale buta tanpa sharpen/deskew/Otsu (`vision.js:306-317`) | 🟠 Tinggi |
| 5 | Parser item mengarang dari metadata EDC; `skipItem` tak lengkap; tanpa batas harga (`vision.js:886-901`) | 🔴 Tinggi |

---

## 3. Perbaikan yang Dilakukan (Sub-Agent 2)

**File diubah:** `js/vision.js` (utama), `js/main.js`.

| Area | Perbaikan Kunci |
|---|---|
| **Validasi quad + fallback crop** | Fungsi `cvQuadSane`/`cvFindReceiptQuad`: tolak quad miring >~10°, gunakan `boundingRect`/`minAreaRect` tanpa warp bila meragukan. Quad miring 27° kini **ditolak** → crop 472×624 (bukan warp 405×579). |
| **Pemilihan sumber OCR terbaik** | `ocrBest()`: OCR multi-sumber (warp/crop + **foto asli** + biner/Otsu/invert), pilih **skor gabungan** = confidence × panjang teks valid × field terparse. Foto asli kini terpilih (conf 38→58). |
| **`matchDate` dukung bulan Inggris** | Regex + map `JAN–DEC`; fuzzy correction `UCI`→`OCT`; format `08 OCT 26`, `08-OCT-26`, `OCT 08, 2026` dsb. Hapus fallback diam-diam `todayISO()` di `main.js`. |
| **Parser item & total EDC** | `skipItem` tambah `batch|trace|ref|appr|merch|pan|nouc|card|issuer|rrn|tid|mid`; batas harga 100–100jt; tolak angka ≥12 digit; deteksi pola EDC → `items = []`; total prioritas GRAND TOTAL. |
| **`pickMerchant`** | Prioritaskan baris paling atas kapital kuat; buang noise; untuk EDC brand toko diprioritaskan. |
| **Preprocessing** | Unsharp mask + normalisasi kontras; varian CLAHE/Otsu/adaptive/invert untuk multi-OCR. |
| **Tesseract config** | Coba PSM 6 & 4 (pilih terbaik); `preserve_interword_spaces='1'`, `user_defined_dpi='300'`; varian `eng` untuk angka. |
| **Konsistensi worker ↔ utama** | Logika CV diekstrak ke fungsi `cv*` & di-`toString()` ke worker → parameter & strategi **identik**. |

---

## 4. Hasil Verifikasi (Sub-Agent 3 — Independen)

| Kriteria | Hasil | Nilai Aktual |
|---|---|---|
| Tanggal = 2026-10-08 | ✅ PASS | `2026-10-08` |
| Total = 77000 | ✅ PASS | `77000` |
| Items = [] (kosong) | ✅ PASS | `[]` |
| Merchant wajar | ✅ PASS | `GOOD FRIENDS HO` (dekat `GOOD FRIENDS-HD`) |
| Aplikasi stabil, tidak crash | ✅ PASS | CV 2.3s, OCR 10s, conf 58 |
| Regresi fitur lama (manual, save, ekspor/impor) | ✅ PASS | Semua normal |

**Uji tambahan lulus:** `matchDate` bulan Inggris, parser struk belanja biasa, parser diskon/pajak, tolak PAN/no referensi panjang, deteksi EDC → `items=[]`.

---

## 5. Sisa Masalah (Dikenal, Non-Blocking)

| # | Masalah | Tingkat | Saran |
|---|---|---|---|
| 1 | Merchant `HD`→`HO` | Rendah | Fuzzy brand / whitelist toko umum. |
| 2 | Koreksi bulan fuzzy heuristik (`UCI`→`OCT`) | Rendah | Tesseract OSD / kamus typo lebih umum. |
| 3 | Tahun 2-digit tak bisa dikoreksi otomatis | Rendah | Domain knowledge: struk tidak dari masa depan. |
| 4 | Deskew/OSD rotasi 90/180/270 belum ada | Sedang | `minAreaRect` + uji rotasi / Tesseract OSD. |
| 5 | Worker error bila CDN OpenCV gagal | Rendah | Embed WASM / Service Worker cache. |
| 6 | Varian OCR adaptif (eng-only, PSM beda, invert) | Rendah | Tambah bila skor awal < threshold. |

---

## 6. Cara Menjalankan

```powershell
cd "C:\Users\setia\OneDrive\ドキュメント\Default Project"
python -m http.server 8080
# Buka http://localhost:8080 → pilih foto struk (kamera/galeri) → periksa hasil.
```

Server lokal **wajib** untuk fitur kamera live (HTTPS/localhost). Buka langsung `index.html` (`file://`) tetap jalan untuk OCR & penyimpanan, tapi kamera live tidak tersedia.

---

## 7. Laporan Lengkap

| File | Isi |
|---|---|
| `laporan/1-diagnosa.md` | Reproduksi, ground truth, akar penyebab berperingkat, bukti visual (`quad-overlay.jpg`), harness. |
| `laporan/2-perbaikan.md` | Daftar perubahan per `file:baris`, alasan, sebelum vs sesudah. Cadangan: `laporan/_backup/*.bak`. |
| `laporan/3-verifikasi.md` | Tabel PASS/FAIL, uji `matchDate`, parser, regresi, bug tersisa. |

---

## 8. Kesimpulan

**Perbaikan BERHASIL.** Aplikasi kini membaca struk contoh EDC BCA dengan benar: tanggal, total, merchant wajar, dan items kosong (seharusnya). Akar utama — **deteksi quad salah + tidak ada fallback OCR ke foto asli** — sudah teratasi. Pipeline lebih tangguh: validasi geometri, multi-sumber OCR dengan pemilihan berbasis field, parsing yang sadar konteks EDC, dan dukungan bulan Inggris.

Fitur yang sudah ada (penyimpanan lokal, ekspor/impor, kamera, mode manual, cloud opsional) **tidak rusak**.

---

## 9. Catatan untuk Pengguna

- Simpan foto struk Anda di `Downloads` (atau mana saja), lalu pilih via tombol **AMBIL FOTO** / **PILIH DARI GALERI** di aplikasi.
- Jika struk miring/gelap/kusut: aplikasi sekarang akan **menolak warp memiringkan** dan memakai **crop/foto asli** yang lebih bagus untuk OCR.
- Hasil OCR tetap bisa dikoreksi manual di form konfirmasi sebelum disimpan.
- Data tersimpan di browser (localStorage). Gunakan **EKSPOR JSON** untuk pindah ke perangkat lain.