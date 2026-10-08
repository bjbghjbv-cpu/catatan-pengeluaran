/* ============================================================
   vision.js — pipeline computer vision + OCR (client-side)

   1. PRE-PROCESSING (OpenCV.js): grayscale, Gaussian blur, CLAHE
   2. DETEKSI STRUK: Canny + findContours + approxPolyDP (4 sudut)
      — divalidasi (quad "melipat" ditolak) + fallback crop sumbu-sejajar
   3. KOREKSI PERSPEKTIF: getPerspectiveTransform + warpPerspective
   4. OCR: Tesseract.js (ind+eng) multi-varian/multi-PSM, pilih terbaik
   5. PARSING: heuristik/regex -> toko, tanggal, item, total

   Catatan: inti deteksi (fungsi cv*) sengaja mandiri (hanya pakai `cv`
   global) agar bisa dijalankan IDENTIK di worker & thread utama (#8).
   ============================================================ */
'use strict';

const Vision = (() => {

  const OPENCV_URL = 'https://docs.opencv.org/4.x/opencv.js';
  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
  const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
  const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

  let cvPromise = null;
  let tessPromise = null;
  let pdfPromise = null;

  /* ---------- Pemuatan library (lazy, sekali saja) ---------- */

  function loadScript(src, timeoutMs) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        s.remove();
        reject(new Error('Waktu unduh habis (koneksi lambat?): ' + src));
      }, timeoutMs || 60000);
      s.src = src;
      s.async = true;
      s.onload = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      s.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        s.remove();
        reject(new Error('Gagal memuat: ' + src));
      };
      document.head.appendChild(s);
    });
  }

  /** Batasi durasi promise — bila lewat batas, lempar error. */
  function withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message || 'Waktu habis')), ms);
      promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
    });
  }

  /**
   * Muat script dengan laporan progres unduhan (bila CORS memungkinkan).
   * onProgress menerima { phase: 'download' | 'compile', percent: number|null }.
   * Bila fetch tidak bisa (tanpa CORS), otomatis pakai <script> biasa.
   */
  async function loadScriptWithProgress(src, timeoutMs, onProgress) {
    const cb = onProgress || function () {};
    try {
      const resp = await withTimeout(fetch(src, { mode: 'cors', cache: 'default' }), timeoutMs, 'Unduh lambat: ' + src);
      if (!resp.ok || !resp.body) throw new Error('Tidak bisa dibaca');
      const total = Number(resp.headers.get('Content-Length')) || 0;
      const reader = resp.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const part = await withTimeout(reader.read(), timeoutMs, 'Unduh terhenti: ' + src);
        if (part.done) break;
        chunks.push(part.value);
        received += part.value.length;
        cb({ phase: 'download', percent: total ? received / total : null });
      }
      const blob = new Blob(chunks, { type: 'application/javascript; charset=utf-8' });
      const url = URL.createObjectURL(blob);
      cb({ phase: 'compile' });
      // Beri jeda 2 frame (dengan cadangan timer) agar teks "Menyusun…" sempat
      // tampil sebelum evaluasi script yang berat memblokir thread utama.
      await new Promise(res => {
        let done = false;
        const finish = () => { if (!done) { done = true; res(); } };
        requestAnimationFrame(() => requestAnimationFrame(finish));
        setTimeout(finish, 120);
      });
      await loadScript(url, timeoutMs);
      URL.revokeObjectURL(url);
    } catch (err) {
      // Tanpa CORS / gagal: pakai <script> biasa (tanpa progres unduhan).
      cb({ phase: 'download' });
      await loadScript(src, timeoutMs);
    }
  }

  /** Muat OpenCV.js dan tunggu WASM siap (cv.Mat tersedia). */
  async function loadOpenCV(onProgress) {
    if (cvPromise) return cvPromise;
    cvPromise = (async () => {
      if (window.cv && window.cv.Mat) return window.cv;
      await loadScriptWithProgress(OPENCV_URL, 120000, onProgress);
      if (!window.cv) throw new Error('OpenCV.js tidak tersedia');
      await new Promise((resolve, reject) => {
        if (window.cv.Mat) return resolve();
        const started = Date.now();
        const poll = setInterval(() => {
          if (window.cv && window.cv.Mat) {
            clearInterval(poll);
            resolve();
          } else if (Date.now() - started > 30000) {
            clearInterval(poll);
            reject(new Error('OpenCV.js memuat terlalu lama'));
          }
        }, 150);
      });
      return window.cv;
    })();
    cvPromise.catch(() => { cvPromise = null; });
    return cvPromise;
  }

  /** Muat Tesseract.js (UMD global: window.Tesseract). */
  async function loadTesseract() {
    if (tessPromise) return tessPromise;
    tessPromise = (async () => {
      if (window.Tesseract) return window.Tesseract;
      await loadScript(TESSERACT_URL, 60000);
      if (!window.Tesseract) throw new Error('Tesseract.js tidak tersedia');
      return window.Tesseract;
    })();
    tessPromise.catch(() => { tessPromise = null; });
    return tessPromise;
  }

  /** Muat PDF.js untuk struk berformat PDF. */
  async function loadPdfJs() {
    if (pdfPromise) return pdfPromise;
    pdfPromise = (async () => {
      if (window.pdfjsLib) return window.pdfjsLib;
      await loadScript(PDFJS_URL, 60000);
      if (!window.pdfjsLib) throw new Error('PDF.js tidak tersedia');
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return window.pdfjsLib;
    })();
    pdfPromise.catch(() => { pdfPromise = null; });
    return pdfPromise;
  }

  /* ---------- Input: file / EXIF / PDF -> canvas ---------- */

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Gambar gagal dimuat'));
      img.src = url;
    });
  }

  /** Baca orientasi EXIF (tag 0x0112) dari file JPEG. */
  function readExifOrientation(bytes) {
    try {
      let i = 2; // setelah SOI
      while (i + 4 < bytes.length) {
        if (bytes[i] !== 0xFF) break;
        const marker = bytes[i + 1];
        if (marker === 0xDA || marker === 0xD9) break; // SOS / EOI
        const len = (bytes[i + 2] << 8) | bytes[i + 3];
        const isExif = marker === 0xE1
          && bytes[i + 4] === 0x45 && bytes[i + 5] === 0x78
          && bytes[i + 6] === 0x69 && bytes[i + 7] === 0x66; // "Exif"
        if (isExif) {
          const tiff = i + 4 + 6;
          const little = bytes[tiff] === 0x49; // "II"
          const read16 = o => little
            ? bytes[tiff + o] | (bytes[tiff + o + 1] << 8)
            : (bytes[tiff + o] << 8) | bytes[tiff + o + 1];
          const ifd0 = tiff + read16(4);
          const count = read16(ifd0 - tiff + 0);
          for (let e = 0; e < count; e++) {
            const off = ifd0 - tiff + 2 + e * 12;
            if (read16(off) === 0x0112) {
              return read16(off + 8) & 0xFFFF;
            }
          }
        }
        i += 2 + len;
      }
    } catch (err) { /* abaikan */ }
    return 1;
  }

  /** Terapkan orientasi EXIF pada konteks canvas. */
  function applyOrientation(ctx, orientation, w, h) {
    switch (orientation) {
      case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
      case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
      case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
      case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
      case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
      case 7: ctx.transform(0, -1, -1, 0, w, h); break;
      case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
      default: break;
    }
  }

  /** Render halaman pertama PDF menjadi canvas. */
  async function renderPdfToCanvas(file) {
    const lib = await loadPdfJs();
    const buf = await file.arrayBuffer();
    const doc = await lib.getDocument({ data: buf }).promise;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  }

  /**
   * File -> canvas dengan orientasi EXIF diperbaiki.
   * Mendukung JPG/PNG (image) dan PDF.
   */
  async function fileToCanvas(file) {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')) {
      return renderPdfToCanvas(file);
    }
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let orientation = 1;
    if (bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8) {
      orientation = readExifOrientation(bytes);
    }
    const url = URL.createObjectURL(new Blob([buf], { type: file.type || 'image/jpeg' }));
    try {
      const img = await loadImage(url);
      const swap = orientation >= 5 && orientation <= 8;
      const canvas = document.createElement('canvas');
      canvas.width = swap ? img.naturalHeight : img.naturalWidth;
      canvas.height = swap ? img.naturalWidth : img.naturalHeight;
      const ctx = canvas.getContext('2d');
      applyOrientation(ctx, orientation, img.naturalWidth, img.naturalHeight);
      ctx.drawImage(img, 0, 0);
      return canvas;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /* ---------- Computer vision: deteksi & warp struk ---------- */

  /** Mat (1 kanal atau RGBA) -> canvas. */
  function matToCanvas(mat) {
    const cv = window.cv;
    const rgba = new cv.Mat();
    if (mat.channels() === 1) cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA);
    else cv.cvtColor(mat, rgba, cv.COLOR_RGBA2RGBA);
    const c = document.createElement('canvas');
    c.width = mat.cols;
    c.height = mat.rows;
    cv.imshow(c, rgba);
    rgba.delete();
    return c;
  }

  /** Perkecil ukuran agar pemrosesan cepat (sisi terpanjang maxDim). */
  function downscale(canvas, maxDim) {
    const max = Math.max(canvas.width, canvas.height);
    const scale = Math.min(1, maxDim / max);
    if (scale >= 1) return canvas;
    const c = document.createElement('canvas');
    c.width = Math.round(canvas.width * scale);
    c.height = Math.round(canvas.height * scale);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(canvas, 0, 0, c.width, c.height);
    return c;
  }

  /**
   * Siapkan gambar untuk OCR (#4): upscale + penajaman kontras ringan.
   * - Upscale ke lebar target 2000px (perilaku yang sudah terbukti baik pada
   *   foto asli).
   * - Varian kontras/Otsu/invert dibuat terpisah di prepareVariant() dan hanya
   *   dipakai bila hasil awal kurang baik, agar tidak mengorbankan kasus yang
   *   sudah bagus.
   */
  function upscaleForOcr(canvas, targetW) {
    const scale = canvas.width < targetW ? (targetW / canvas.width) : 1;
    const w = Math.max(1, Math.round(canvas.width * scale));
    const h = Math.max(1, Math.round(canvas.height * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, w, h);
    return c;
  }

  function prepareForOcr(canvas) {
    return upscaleForOcr(canvas, 2000);
  }

  /** Terapkan filter CSS ke canvas (dipakai varian kontras). */
  function applyCssFilter(canvas, filter) {
    const c = document.createElement('canvas');
    c.width = canvas.width;
    c.height = canvas.height;
    const ctx = c.getContext('2d');
    try { ctx.filter = filter; } catch (e) { /* abaikan */ }
    ctx.drawImage(canvas, 0, 0);
    ctx.filter = 'none';
    return c;
  }

  /** Binarisasi Otsu global murni-JS (tanpa OpenCV di thread utama). */
  function otsuBinary(canvas) {
    const w = canvas.width, h = canvas.height;
    const src = canvas.getContext('2d').getImageData(0, 0, w, h);
    const p = src.data;
    const gray = new Uint8Array(w * h);
    const hist = new Float64Array(256);
    for (let i = 0, j = 0; i < p.length; i += 4, j++) {
      const g = (0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]) | 0;
      gray[j] = g; hist[g]++;
    }
    const total = w * h;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, maxVar = 0, thr = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > maxVar) { maxVar = between; thr = t; }
    }
    const out = canvas.getContext('2d').createImageData(w, h);
    const o = out.data;
    for (let j = 0; j < gray.length; j++) {
      const v = gray[j] > thr ? 255 : 0;
      o[j * 4] = o[j * 4 + 1] = o[j * 4 + 2] = v; o[j * 4 + 3] = 255;
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').putImageData(out, 0, 0);
    return c;
  }

  /**
   * Varian gambar untuk OCR (#4). 'plain' = perilaku default (upscale) yang
   * aman; varian lain ditambahkan HANYA bila hasil awal kurang baik, agar
   * tidak membuang waktu.
   */
  function prepareVariant(canvas, kind) {
    if (kind === 'gray') return applyCssFilter(upscaleForOcr(canvas, 2000), 'grayscale(1) contrast(1.25) brightness(1.05)');
    if (kind === 'otsu') return otsuBinary(upscaleForOcr(canvas, 1600));
    if (kind === 'invert') return applyCssFilter(upscaleForOcr(canvas, 2000), 'invert(1)');
    return prepareForOcr(canvas);
  }

  /* ---------- Inti deteksi struk (dipakai bersama worker & thread utama) ----------
     Fungsi cv* di bawah ini SENGAJA mandiri: tidak menutup variabel luar dan
     hanya memakai `cv` global, sehingga bisa di-stringify (Function.toString)
     dan dijalankan di dalam worker CV. Dengan begitu parameter strategi worker
     dan thread utama PERSIS sama (#8) — hasil konsisten & mudah di-debug. */

  function cvDist(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** Urutkan 4 titik: kiri-atas, kanan-atas, kanan-bawah, kiri-bawah. */
  function cvOrderPoints(pts) {
    const sum = pts.map(function (p) { return p.x + p.y; });
    const diff = pts.map(function (p) { return p.y - p.x; });
    function idxMin(arr) { let b = 0; for (let i = 1; i < arr.length; i++) if (arr[i] < arr[b]) b = i; return b; }
    function idxMax(arr) { let b = 0; for (let i = 1; i < arr.length; i++) if (arr[i] > arr[b]) b = i; return b; }
    return [pts[idxMin(sum)], pts[idxMin(diff)], pts[idxMax(sum)], pts[idxMax(diff)]];
  }

  /**
   * Validasi quad (#1): tolak quad "melipat" yang bisa membuat warp miring.
   * Pada foto asli, quad salah punya sudut kanan-atas jatuh di tengah sisi →
   * sisi kiri/kanan panjangnya beda jauh. Ambang rasio sisi 0,72.
   * Sudut antar sisi juga harus mendekati siku (55°–125°).
   */
  function cvQuadSane(pts) {
    if (!pts || pts.length !== 4) return false;
    const top = cvDist(pts[0], pts[1]), right = cvDist(pts[1], pts[2]);
    const bottom = cvDist(pts[2], pts[3]), left = cvDist(pts[3], pts[0]);
    if (top < 30 || right < 30 || bottom < 30 || left < 30) return false;
    if (Math.min(top, bottom) / Math.max(top, bottom) < 0.72) return false;
    if (Math.min(left, right) / Math.max(left, right) < 0.72) return false;
    for (let i = 0; i < 4; i++) {
      const p = pts[i], a = pts[(i + 3) % 4], b = pts[(i + 1) % 4];
      const v1x = a.x - p.x, v1y = a.y - p.y, v2x = b.x - p.x, v2y = b.y - p.y;
      const den = cvDist(a, p) * cvDist(b, p);
      if (den < 1) return false;
      let cang = (v1x * v2x + v1y * v2y) / den;
      if (cang > 1) cang = 1; if (cang < -1) cang = -1;
      const ang = Math.acos(cang) * 180 / Math.PI;
      if (ang < 55 || ang > 125) return false;
    }
    return true;
  }

  /**
   * Cari area struk. Kembalian:
   *  { quad, cropRect, note, cropNote, enhanced, blurred, edges }
   * quad = 4 titik (valid) untuk warp; bila tidak ada quad valid, gunakan
   * cropRect sumbu-sejajar (tanpa warp) — lebih aman daripada warp miring.
   */
  function cvFindReceiptQuad(src) {
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    const enhanced = new cv.Mat();
    new cv.CLAHE(2.0, new cv.Size(8, 8)).apply(blurred, enhanced);
    gray.delete();

    const totalArea = src.cols * src.rows;
    const info = { quad: null, cropRect: null, note: '', cropNote: '', enhanced: enhanced, blurred: blurred, edges: null };

    // --- Strategi 1: Canny + approxPolyDP, lalu validasi kekerasan quad ---
    const edges = new cv.Mat();
    cv.Canny(enhanced, edges, 60, 180);
    info.edges = edges;
    const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    const closed = new cv.Mat();
    cv.dilate(edges, closed, kernel);
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const minArea = totalArea * 0.08;
    const epsList = [0.02, 0.03, 0.04, 0.05, 0.06, 0.08];
    let bestQuad = null, bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area < minArea || area > totalArea * 0.92) continue;
      const peri = cv.arcLength(cnt, true);
      for (let k = 0; k < epsList.length; k++) {
        const approx = new cv.Mat();
        cv.approxPolyDP(cnt, approx, epsList[k] * peri, true);
        if (approx.rows === 4) {
          const pts = [];
          for (let q = 0; q < 4; q++) pts.push({ x: approx.data32S[q * 2], y: approx.data32S[q * 2 + 1] });
          const o = cvOrderPoints(pts);
          if (cvQuadSane(o) && area > bestArea) { bestArea = area; bestQuad = o; }
        }
        approx.delete();
      }
    }
    contours.delete(); hierarchy.delete(); closed.delete(); kernel.delete();

    if (bestQuad) {
      info.quad = bestQuad;
      info.note = 'Struk terdeteksi (4 sudut tervalidasi) — diluruskan otomatis.';
      return info;
    }

    // --- Strategi 2: area terang (kertas) -> crop sumbu-sejajar (tanpa warp) ---
    const chans = new cv.MatVector();
    cv.split(src, chans);
    const mn = new cv.Mat(); cv.min(chans.get(0), chans.get(1), mn);
    const mn2 = new cv.Mat(); cv.min(mn, chans.get(2), mn2);
    const mask = new cv.Mat(); cv.threshold(mn2, mask, 175, 255, cv.THRESH_BINARY);
    chans.delete(); mn.delete(); mn2.delete();
    const mk = cv.Mat.ones(7, 7, cv.CV_8U);
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, mk);
    mk.delete();
    const cs = new cv.MatVector(); const hs = new cv.Mat();
    cv.findContours(mask, cs, hs, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let bestC = null, bestCA = 0;
    for (let c2 = 0; c2 < cs.size(); c2++) {
      const cc = cs.get(c2);
      const ar = cv.contourArea(cc);
      if (ar < totalArea * 0.06 || ar > totalArea * 0.92) continue;
      if (ar > bestCA) { bestCA = ar; bestC = cc; }
    }
    if (bestC) {
      const br = cv.boundingRect(bestC);
      // Batasi agar tidak memotong seluruh meja (harus agak memanjang ke bawah).
      if (br.width > 40 && br.height > 40 && br.height >= br.width * 0.6) {
        info.cropRect = { x: br.x, y: br.y, width: br.width, height: br.height };
        info.cropNote = 'Struk terdeteksi & dipotong (tanpa pelurusan).';
      }
    }
    cs.delete(); hs.delete(); mask.delete();
    if (info.cropRect) info.note = info.cropNote;
    return info;
  }

  /** Warp perspektif dari 4 titik -> Mat baru (atau null bila ukuran tak wajar). */
  function cvWarpQuad(srcMat, quad) {
    const o = cvOrderPoints(quad);
    const w = Math.round(Math.max(cvDist(o[0], o[1]), cvDist(o[2], o[3])));
    const h = Math.round(Math.max(cvDist(o[3], o[0]), cvDist(o[2], o[1])));
    if (!(w > 40 && h > 40 && w < 8000 && h < 8000)) return null;
    const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [o[0].x, o[0].y, o[1].x, o[1].y, o[2].x, o[2].y, o[3].x, o[3].y]);
    const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w - 1, 0, w - 1, h - 1, 0, h - 1]);
    const M = cv.getPerspectiveTransform(srcPts, dstPts);
    const out = new cv.Mat();
    cv.warpPerspective(srcMat, out, M, new cv.Size(w, h), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
    srcPts.delete(); dstPts.delete(); M.delete();
    return out;
  }

  /** Crop sumbu-sejajar + padding kecil -> Mat baru (atau null). */
  function cvCropRect(srcMat, r) {
    const pad = Math.round(Math.min(r.width, r.height) * 0.03);
    const rx = Math.max(0, r.x - pad), ry = Math.max(0, r.y - pad);
    const rw = Math.min(srcMat.cols - rx, r.width + pad * 2);
    const rh = Math.min(srcMat.rows - ry, r.height + pad * 2);
    if (!(rw > 40 && rh > 40)) return null;
    const roi = srcMat.roi(new cv.Rect(rx, ry, rw, rh));
    const out = roi.clone();
    roi.delete();
    return out;
  }

  /** Binarisasi adaptif kanonik (parameter sama di worker & utama, #8). */
  function cvAdaptiveMat(grayMat) {
    const bin = new cv.Mat();
    cv.adaptiveThreshold(grayMat, bin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 41, 18);
    return bin;
  }

  /**
   * Siapkan satu struk: cari area, warp/crop, lalu bikin versi biner scan.
   * Kembalian { scanMat, binMat, quad, note }. Mat harus di-delete pemanggil.
   */
  function cvPrepareReceipt(src) {
    const info = cvFindReceiptQuad(src);
    let scanMat = null, quad = null, note = '';
    if (info.quad) {
      scanMat = cvWarpQuad(info.enhanced, info.quad);
      if (scanMat) { quad = cvOrderPoints(info.quad); note = info.note; }
    }
    if (!scanMat && info.cropRect) {
      scanMat = cvCropRect(info.enhanced, info.cropRect);
      if (scanMat) note = info.cropNote || 'Struk terdeteksi & dipotong.';
    }
    if (!scanMat) {
      scanMat = info.enhanced.clone();
      note = 'Struk tidak terdeteksi — memakai foto penuh.';
    }
    const binMat = cvAdaptiveMat(scanMat);
    info.enhanced.delete();
    info.blurred.delete();
    if (info.edges) info.edges.delete();
    return { scanMat: scanMat, binMat: binMat, quad: quad, note: note };
  }

  /**
   * Pipeline deteksi struk versi thread utama (fallback bila worker gagal).
   * Kembali: { scan, scanBin, quad (0-1), note }.
   */
  function detectAndWarp(canvas) {
    const cv = window.cv;
    const ctx = canvas.getContext('2d');
    const src = cv.matFromImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
    let res;
    try {
      res = cvPrepareReceipt(src);
    } finally {
      src.delete();
    }
    const out = {
      scan: matToCanvas(res.scanMat),
      scanBin: matToCanvas(res.binMat),
      quad: res.quad ? res.quad.map(p => ({ x: p.x / canvas.width, y: p.y / canvas.height })) : null,
      note: res.note
    };
    res.scanMat.delete();
    res.binMat.delete();
    return out;
  }

  /** Binarisasi adaptif — dipakai sebagai varian OCR cadangan. */
  function binarize(canvas) {
    const cv = window.cv;
    const ctx = canvas.getContext('2d');
    const src = cv.matFromImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const bin = cvAdaptiveMat(gray);
    const out = matToCanvas(bin);
    src.delete(); gray.delete(); bin.delete();
    return out;
  }

  /* ---------- Pemrosesan vision di WORKER (UI tidak beku) ---------- */

  let cvWorker = null;         // Worker vision (dipakai ulang antar-scan)
  let cvWorkerFailed = false;  // Bila worker tak bisa dipakai -> fallback thread utama

  /**
   * Kode sumber worker. Inti deteksi (cvPrepareReceipt dkk) di-stringify dari
   * fungsi yang sama dengan thread utama -> hasil KONSISTEN (#8).
   */
  function buildWorkerSource() {
    const shared = [cvDist, cvOrderPoints, cvQuadSane, cvFindReceiptQuad,
      cvWarpQuad, cvCropRect, cvAdaptiveMat, cvPrepareReceipt]
      .map(fn => fn.toString()).join('\n');
    return [
      "'use strict';",
      "var READY = false; var FAILED = null;",
      "try { importScripts('" + OPENCV_URL + "'); } catch (e) { FAILED = 'Gagal memuat OpenCV: ' + e; }",
      "var DEADLINE = Date.now() + 240000;",
      "(function wait() {",
      "  if (self.cv && self.cv.Mat) { READY = true; self.postMessage({ type: 'ready' }); return; }",
      "  if (FAILED) { self.postMessage({ type: 'error', message: FAILED }); return; }",
      "  if (Date.now() > DEADLINE) { self.postMessage({ type: 'error', message: 'OpenCV terlalu lama di worker' }); return; }",
      "  setTimeout(wait, 150);",
      "})();",
      "function whenReady(cb) {",
      "  if (READY) return cb();",
      "  if (FAILED) { self.postMessage({ type: 'error', message: FAILED }); return; }",
      "  var t = setInterval(function () {",
      "    if (READY) { clearInterval(t); cb(); }",
      "    else if (FAILED) { clearInterval(t); self.postMessage({ type: 'error', message: FAILED }); }",
      "  }, 150);",
      "}",
      "function toRGBA(mat) {",
      "  var rgba = new cv.Mat();",
      "  cv.cvtColor(mat, rgba, mat.channels() === 1 ? cv.COLOR_GRAY2RGBA : cv.COLOR_RGBA2RGBA);",
      "  var copy = new Uint8ClampedArray(rgba.data.length); copy.set(rgba.data);",
      "  var r = { width: rgba.cols, height: rgba.rows, buffer: copy.buffer };",
      "  rgba.delete(); return r;",
      "}",
      shared,
      "function processReceipt(msg) {",
      "  var data = new Uint8ClampedArray(msg.buffer);",
      "  var src = cv.matFromImageData({ data: data, width: msg.width, height: msg.height });",
      "  var res = cvPrepareReceipt(src);",
      "  src.delete();",
      "  var out = {",
      "    type: 'result',",
      "    scan: toRGBA(res.scanMat),",
      "    scanBin: toRGBA(res.binMat),",
      "    quad: res.quad ? res.quad.map(function (p) { return { x: p.x / msg.width, y: p.y / msg.height }; }) : null,",
      "    note: res.note",
      "  };",
      "  res.scanMat.delete(); res.binMat.delete();",
      "  return out;",
      "}",
      "self.onmessage = function (ev) {",
      "  var msg = ev.data || {};",
      "  if (msg.type !== 'process') return;",
      "  whenReady(function () {",
      "    try {",
      "      var out = processReceipt(msg);",
      "      self.postMessage(out, [out.scan.buffer, out.scanBin.buffer]);",
      "    } catch (err) {",
      "      self.postMessage({ type: 'error', message: String(err && err.message || err) });",
      "    }",
      "  });",
      "};"
    ].join('\n');
  }

  function ensureCvWorker() {
    if (cvWorker) return cvWorker;
    if (cvWorkerFailed) return null;
    try {
      const blob = new Blob([buildWorkerSource()], { type: 'application/javascript' });
      cvWorker = new Worker(URL.createObjectURL(blob));
      return cvWorker;
    } catch (err) {
      console.warn('Worker vision tidak bisa dibuat:', err);
      cvWorkerFailed = true;
      return null;
    }
  }

  function processInWorker(canvas, onProgress) {
    return new Promise((resolve, reject) => {
      const w = ensureCvWorker();
      if (!w) { reject(new Error('worker tidak tersedia')); return; }
      let settled = false;
      const done = (err, val) => {
        if (settled) return;
        settled = true;
        w.onmessage = null;
        w.onerror = null;
        if (err) reject(err); else resolve(val);
      };
      w.onerror = () => { cvWorkerFailed = true; done(new Error('worker error')); };
      w.onmessage = ev => {
        const m = ev.data || {};
        if (m.type === 'ready') { if (onProgress) onProgress({ phase: 'compile', worker: true }); return; }
        if (m.type === 'error') { cvWorkerFailed = true; done(new Error(m.message || 'worker gagal')); return; }
        if (m.type === 'result') {
          const c = document.createElement('canvas');
          c.width = m.scan.width;
          c.height = m.scan.height;
          c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(m.scan.buffer), m.scan.width, m.scan.height), 0, 0);
          let binCanvas = null;
          if (m.scanBin && m.scanBin.buffer) {
            binCanvas = document.createElement('canvas');
            binCanvas.width = m.scanBin.width;
            binCanvas.height = m.scanBin.height;
            binCanvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(m.scanBin.buffer), m.scanBin.width, m.scanBin.height), 0, 0);
          }
          done(null, { scan: c, scanBin: binCanvas, quad: m.quad, note: m.note });
        }
      };
      if (onProgress) onProgress({ phase: 'compile', worker: true });
      try {
        const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        w.postMessage({ type: 'process', width: img.width, height: img.height, buffer: img.data.buffer }, [img.data.buffer]);
      } catch (err) {
        cvWorkerFailed = true;
        done(err);
      }
    });
  }

  /**
   * Siapkan hasil computer vision untuk satu foto.
   * Prioritas: worker (UI tidak beku). Bila gagal -> thread utama (fallback).
   */
  async function prepareReceiptVision(canvas, onProgress) {
    if (!cvWorkerFailed) {
      try {
        return await processInWorker(canvas, onProgress);
      } catch (err) {
        console.warn('Vision di worker gagal, pakai thread utama:', err);
      }
    }
    if (onProgress) onProgress({ phase: 'compile', worker: false });
    await loadOpenCV(onProgress);
    return detectAndWarp(canvas);
  }

  /* ---------- OCR ---------- */

  let tessWorker = null;         // Worker Tesseract dipakai ulang (lebih cepat)
  let tessWorkerLang = null;
  let tessWorkerPromise = null;
  let tessProgressCb = null;     // callback progres aktif (dibaca logger worker)

  /** Worker Tesseract yang dipakai ulang; dibuat sekali per bahasa. */
  async function getTessWorker(lang, onProgress) {
    const L = lang || 'ind+eng';
    if (tessWorker && tessWorkerLang === L) return tessWorker;
    if (tessWorkerPromise && tessWorkerLang === L) return tessWorkerPromise;
    if (tessWorker) { try { await tessWorker.terminate(); } catch (e) { /* abaikan */ } tessWorker = null; }
    tessWorkerLang = L;
    tessWorkerPromise = (async () => {
      const T = await loadTesseract();
      const w = await T.createWorker(L, 1, {
        logger: m => {
          const cb = tessProgressCb;
          if (!cb) return;
          const p = (m && typeof m.progress === 'number') ? Math.max(0, Math.min(1, m.progress)) : null;
          cb(p, (m && m.status) || '');
        }
      });
      tessWorker = w;
      return w;
    })();
    tessWorkerPromise.catch(() => { tessWorkerPromise = null; tessWorkerLang = null; });
    return tessWorkerPromise;
  }

  /**
   * Tesseract lokal. opts: { psm, lang }.
   * PSM + preserve_interword_spaces + user_defined_dpi diatur eksplisit (#7).
   */
  async function tesseractOcr(canvas, onProgress, opts) {
    const o = opts || {};
    const lang = o.lang || 'ind+eng';
    tessProgressCb = onProgress || null;
    try {
      const w = await getTessWorker(lang, onProgress);
      await w.setParameters({
        tessedit_pageseg_mode: String(o.psm || '3'),
        preserve_interword_spaces: '1',
        user_defined_dpi: '300'
      });
      const res = await w.recognize(canvas);
      const data = (res && res.data) ? res.data : {};
      let lines = [];
      if (Array.isArray(data.lines)) {
        lines = data.lines
          .map(l => {
            const b = l.bbox || {};
            return { text: String(l.text || ''), y0: Number(b.y0) || 0, y1: Number(b.y1) || 0 };
          })
          .filter(l => l.text.trim());
      }
      return {
        text: data.text ? String(data.text) : '',
        lines,
        confidence: (typeof data.confidence === 'number') ? data.confidence : null
      };
    } finally {
      tessProgressCb = null;
    }
  }

  /** Google Cloud Vision (TEXT_DETECTION) — butuh API key. */
  async function googleOcr(canvas, key) {
    const base64 = canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
    const res = await fetch('https://vision.googleapis.com/v1/images:annotate?key=' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ image: { content: base64 }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }] }]
      })
    });
    if (!res.ok) throw new Error('Cloud Vision error ' + res.status);
    const json = await res.json();
    const resp = json.responses && json.responses[0];
    return { text: (resp && resp.fullTextAnnotation && resp.fullTextAnnotation.text) || '', lines: [] };
  }

  /** Azure Computer Vision (OCR v3.2 sinkron) — butuh key + endpoint. */
  async function azureOcr(canvas, settings) {
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    const url = settings.endpoint.replace(/\/+$/, '') + '/vision/v3.2/ocr?language=unk&detectOrientation=true';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Ocp-Apim-Subscription-Key': settings.key
      },
      body: blob
    });
    if (!res.ok) throw new Error('Azure error ' + res.status);
    const json = await res.json();
    const lines = (json.regions || []).flatMap(r => r.lines || [])
      .map(l => (l.words || []).map(w => w.text).join(' '));
    return { text: lines.join('\n'), lines: [] };
  }

  /**
   * OCR dengan penyedia sesuai pengaturan.
   * opts (opsional, hanya Tesseract): { psm, lang }.
   */
  async function ocr(canvas, settings, onProgress, opts) {
    const s = settings || {};
    if (s.provider === 'google' && s.key) return googleOcr(canvas, s.key);
    if (s.provider === 'azure' && s.key && s.endpoint) return azureOcr(canvas, s);
    return tesseractOcr(canvas, onProgress, opts);
  }

  /* ---------- Pemilihan hasil OCR terbaik (#2, #7) ---------- */

  /**
   * Skor gabungan hasil OCR: BUKAN confidence mentah, tetapi
   * confidence + panjang teks valid + jumlah kata + jumlah field terparsing
   * (merchant/tanggal/total/item). Dipakai untuk membandingkan sumber & PSM.
   */
  function ocrTextScore(text, conf) {
    const t = String(text || '');
    const compact = t.replace(/\s/g, '');
    const words = (t.match(/[A-Za-z]{2,}/g) || []).length;
    let score = 0;
    if (typeof conf === 'number' && !isNaN(conf)) score += conf;
    score += Math.min(90, compact.length / 6);
    score += Math.min(50, words);
    const p = parseReceiptText(t, []);
    if (p.merchant && p.merchant.replace(/[^A-Za-z]/g, '').length >= 3) score += 35;
    if (p.tanggal) score += 45;
    if (p.total != null) score += 55;
    if (p.items && p.items.length) score += Math.min(24, p.items.length * 4);
    return score;
  }

  /** Cek apakah hasil OCR sudah memuat field penting (untuk berhenti lebih awal). */
  function ocrFieldsComplete(text) {
    const p = parseReceiptText(String(text || ''), []);
    return p.total != null && (p.tanggal != null || (p.merchant && p.merchant.length >= 4));
  }

  /**
   * OCR beberapa SUMBER (hasil warp/potong + FOTO ASLI + varian biner) dan pilih
   * hasil terbaik dengan skor gabungan. Membatasi jumlah percobaan agar tidak
   * lambat: ronde 1 semua sumber (PSM 3), ronde 2 PSM lain bila skor rendah /
   * field penting belum lengkap (maks 4 percobaan).
   * Kembali: { text, lines, confidence, variants }.
   */
  async function ocrBest(sources, settings, onProgress) {
    const s = settings || {};
    const variants = [];

    if (s.provider === 'google' || s.provider === 'azure') {
      const first = (sources || []).find(x => x && x.canvas);
      if (!first) return { text: '', lines: [], confidence: null, variants };
      const r = await ocr(prepareForOcr(first.canvas), s, onProgress);
      return {
        text: (r && r.text) || '',
        lines: (r && r.lines) || [],
        confidence: (r && typeof r.confidence === 'number') ? r.confidence : null,
        variants
      };
    }

    const list = (sources || []).filter(x => x && x.canvas).slice(0, 3);

    const runOne = async (srcCanvas, psm, tag, kind) => {
      try {
        const r = await ocr(prepareVariant(srcCanvas, kind), { provider: 'none' }, onProgress, { psm });
        const text = (r && r.text) || '';
        const conf = (r && typeof r.confidence === 'number') ? r.confidence : null;
        const entry = { tag, psm, kind: kind || 'plain', text, lines: (r && r.lines) || [], confidence: conf, srcCanvas };
        entry.score = ocrTextScore(text, conf);
        variants.push(entry);
        return entry;
      } catch (err) {
        console.warn('OCR varian gagal (' + tag + ' psm ' + psm + '):', err);
        return null;
      }
    };

    // Ronde 1: tiap sumber dengan cara default (plain + PSM 3).
    let best = null;
    for (const src of list) {
      const v = await runOne(src.canvas, '3', src.tag || '', 'plain');
      if (v && (!best || v.score > best.score)) best = v;
    }

    // Ronde 2 (hanya bila perlu): varian preprocessing & PSM lain pada sumber
    // terbaik. Batasi total percobaan maks 4 agar tidak lambat.
    const plans = [
      { kind: 'plain', psm: '6' },
      { kind: 'gray', psm: '3' },
      { kind: 'otsu', psm: '6' }
    ];
    const needMore = !best || best.score < 150 || !ocrFieldsComplete(best.text);
    if (needMore && best) {
      for (const plan of plans) {
        if (variants.length >= 4) break;
        const v = await runOne(best.srcCanvas, plan.psm, (best.tag || '') + '/' + plan.kind, plan.kind);
        if (v && v.score > best.score) best = v;
      }
    }

    if (!best) return { text: '', lines: [], confidence: null, variants };
    return { text: best.text, lines: best.lines, confidence: best.confidence, variants };
  }

  /* ---------- Parsing hasil OCR (heuristik/regex) ---------- */

  // Nama bulan digabung Indonesia + Inggris (struk BCA/Epson sering pakai
  // Inggris: "08 OCT 26"). Kunci = 3 huruf pertama, nilai = indeks bulan 0-11.
  const BULAN_MAP = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, mei: 4,
    jun: 5, jul: 6, aug: 7, agu: 7, agst: 7,
    sep: 8, oct: 9, okt: 9, nov: 10, dec: 11, des: 11
  };
  const BULAN_RE = '(jan|feb|mar|apr|may|mei|jun|jul|aug|agu|agst|sep|oct|okt|nov|dec|des)';

  /** Jarak edit Levenshtein sederhana (toleransi salah-baca OCR nama bulan). */
  function editDistance(a, b) {
    const m = a.length, n = b.length;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      const t = prev; prev = cur; cur = t;
    }
    return prev[n];
  }

  // Kata 3 huruf umum di struk yang TIDAK boleh ditafsirkan sebagai bulan.
  const FUZZY_STOP = /^(sun|non|the|and|you|our|all|out|new|top|net|sub|tax|tan|tri|bin|sia|box|ref|no|rp|pan|kas|qty|pcs|ttl|dpp|ppn)$/;

  /**
   * Tebak bulan dari token 3 huruf hasil OCR (mis. "UCI"/"OLI" -> OCT).
   * Pakai jarak edit + bobot posisi (huruf awal lebih menentukan) sebagai
   * tie-breaker, karena beberapa bulan bisa berjarak sama (mis. UCI dekat
   * ke OCT dan MEI).
   */
  function fuzzyMonth(token) {
    const t = String(token || '').toLowerCase();
    if (t.length !== 3) return null;
    if (FUZZY_STOP.test(t)) return null;
    if (BULAN_MAP[t] != null) return BULAN_MAP[t];
    let best = null, bestD = 9, bestPos = -1;
    for (const key in BULAN_MAP) {
      const d = editDistance(t, key);
      if (d > 2) continue;
      let pos = 0;
      for (let i = 0; i < 3; i++) if (t[i] === key[i]) pos += (3 - i);
      if (d < bestD || (d === bestD && pos > bestPos)) { bestD = d; bestPos = pos; best = BULAN_MAP[key]; }
    }
    // Harus ada minimal satu huruf yang cocok posisinya (menghindari tebakan liar).
    return bestPos > 0 ? best : null;
  }

  /** Bikin ISO dari (d, mo, y); null bila tak masuk akal. */
  function isoDate(d, mo, y) {
    if (y < 100) y += 2000;
    if (y < 1990 || y > 2100) return null;
    if (!(d >= 1 && d <= 31)) return null;
    if (!(mo >= 0 && mo <= 11)) return null;
    const dt = new Date(Date.UTC(y, mo, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo || dt.getUTCDate() !== d) return null;
    return y + '-' + String(mo + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  /**
   * Cari tanggal pada satu baris (#3). Mendukung:
   *  - numerik dd/mm/yyyy · dd-mm-yy · dd.mm.yyyy
   *  - nama bulan ID/EN: 07 Okt 2026 · 08 OCT 26 · 08-OCT-26 · OCT 08, 2026
   *  - fuzzy salah-baca OCR: 08 UCI 26 -> 2026-10-08
   */
  function matchDate(line) {
    const s = String(line || '');

    // 1. Numerik dd?mm?yyyy
    let m = s.match(/(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
    if (m) {
      const iso = isoDate(+m[1], +m[2] - 1, +m[3]);
      if (iso) return iso;
    }

    // 2. dd MMM yyyy (pemisah spasi/-//. atau nama bulan panjang)
    m = s.match(new RegExp('(\\d{1,2})[\\s\\-./]*' + BULAN_RE + '[a-z]*\\.?[\\s\\-./]*(\\d{2,4})', 'i'));
    if (m) {
      const mo = BULAN_MAP[String(m[2]).toLowerCase().slice(0, 3)];
      if (mo != null) {
        const iso = isoDate(+m[1], mo, +m[3]);
        if (iso) return iso;
      }
    }

    // 3. MONTH dd, yyyy (gaya Amerika: "OCT 08, 2026")
    m = s.match(new RegExp(BULAN_RE + '[a-z]*\\.?[\\s\\-./]*(\\d{1,2})[\\s,.\\-/]*(\\d{2,4})', 'i'));
    if (m) {
      const mo = BULAN_MAP[String(m[1]).toLowerCase().slice(0, 3)];
      if (mo != null) {
        const iso = isoDate(+m[2], mo, +m[3]);
        if (iso) return iso;
      }
    }

    // 4. Fuzzy: dd XYZ yy, XYZ salah dibaca OCR (mis. UCI/OLI -> OCT).
    m = s.match(/(\d{1,2})\s+([A-Za-z]{3})\.?\s+(\d{2,4})(?=\s|$)/);
    if (m) {
      const mo = fuzzyMonth(m[2]);
      if (mo != null) {
        const iso = isoDate(+m[1], mo, +m[3]);
        if (iso) return iso;
      }
    }
    return null;
  }

  /* ---------- Ekstraksi nama toko ---------- */

  const MERCHANT_JUNK = /(telp|telepon|phone|www\.|http|@|kasir|cashier|struk|nota|bukti|kwitansi|selamat|terima|sambut|datang|member|pelanggan|customer|waktu|jam\b|tanggal|salinan|untuk merchant|pembelian|penjualan|toko serba|swalayan|jl\.?|jalan|\bno\b|nomor|rt\b|rw\b|blok|gedung|ruko|kav|desa|kel\.?|kec\.?|kab\.?|provinsi|outlet|cabang|invoice|order no|debit|kredit|credit|qris|transfer|payment|pembayaran|issuer|batch|trace|appr|approval|ref\.?no|\bref\b|pan\b|pan#|rrn|cardholder|signature|merch|terminal|acquirer|edc\b|bank\b|bca\b|mandiri|bni|bri\b|dana\b|ovo\b|gopay|shopeepay|linkaja|saldo|balance|pemblokiran)/i;

  function cleanMerchant(t) {
    return String(t || '')
      .replace(/[«»*•●=|_\u2014\u2013]+/g, ' ')
      .replace(/^\d{1,3}\s+[/\\|]+\s+/, '')     // buang prefix noise spt "23 \ "
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s.\-:;,\/\\]+|[\s.\-:;,\/\\]+$/g, '')
      .trim();
  }

  /** Skor kelayakan baris sebagai nama toko: banyak huruf, sedikit angka, KAPITAL. */
  function merchantLineScore(t) {
    const text = String(t || '');
    const letters = (text.match(/[A-Za-z]/g) || []).length;
    const digits = (text.match(/\d/g) || []).length;
    const upper = (text.match(/[A-Z]/g) || []).length;
    if (letters < 2) return -1;
    if (digits > letters) return -1; // didominasi angka: kode/alamat/telepon
    if (/[^\w\s&'.,\-()/]/.test(text)) return -1; // simbol aneh = noise OCR
    let s = letters - digits * 1.5;
    if (upper / letters >= 0.55) s += 3; // nama toko biasanya KAPITAL
    if (text.length > 32) s -= (text.length - 32) * 0.5;
    return s;
  }

  /**
   * Nama toko (#6): prioritaskan baris paling ATAS berhuruf kapital kuat
   * (brand toko biasanya baris pertama bermakna; bank/alamat di bawahnya),
   * buang baris junk/noise.
   */
  function pickMerchant(rawText, layoutLines) {
    const candidates = [];
    const consider = (rawLine, y, h) => {
      const text = cleanMerchant(rawLine);
      if (!text) return;
      if (text.length < 4 || text.length > 40) return;
      if (!/[A-Za-z]{3,}/.test(text)) return;
      if (MERCHANT_JUNK.test(text)) return;
      const letters = (text.match(/[A-Za-z]/g) || []).length;
      if (letters < 4) return; // buang "BCA", "A Si"
      const score = merchantLineScore(text);
      if (score <= 0) return;
      candidates.push({ text, y: (y == null ? 0 : y), h: h || 0, score });
    };

    if (Array.isArray(layoutLines) && layoutLines.length) {
      for (const l of layoutLines) consider(l.text, l.y0, (l.y1 || 0) - (l.y0 || 0));
    } else {
      const lines = String(rawText || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      lines.forEach((l, i) => consider(l, i, 0));
    }

    if (!candidates.length) return '';
    // Ambil kandidat KUAT (skor mendekati terbaik) yang paling atas.
    const maxScore = Math.max.apply(null, candidates.map(c => c.score));
    const strong = candidates.filter(c => c.score >= maxScore * 0.6);
    strong.sort((a, b) => (a.y - b.y) || (b.score - a.score));
    return strong[0].text;
  }

  /** Ambil nama toko terbaik dari beberapa hasil OCR (mis. varian PSM). */
  function pickMerchantFromVariants(variants) {
    let best = '';
    let bestScore = -1;
    for (const v of (variants || [])) {
      const m = pickMerchant(v.text, v.lines);
      if (!m) continue;
      const s = merchantLineScore(m);
      if (s > bestScore) { bestScore = s; best = m; }
    }
    return best;
  }

  /**
   * Parse teks OCR mentah menjadi data terstruktur.
   * layoutLines (opsional): baris + posisi dari OCR, untuk menebak nama toko.
   * Kembali: { merchant, tanggal, items: [{nama, harga}], total }
   */
  function parseReceiptText(raw, layoutLines) {
    const result = { merchant: '', tanggal: null, items: [], total: null };
    if (!raw || typeof raw !== 'string') return result;

    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

    // Batas harga wajar (hindari nomor referensi/PAN jadi "harga").
    const HARGA_MIN = 100, HARGA_MAX = 100000000;

    // Tanggal — tanggal pertama yang cocok
    for (const line of lines) {
      const d = matchDate(line);
      if (d) { result.tanggal = d; break; }
    }

    // Total — utamakan "grand total"/"total", lalu nilai terbesar; hanya pada
    // baris ber-kata kunci total (#5, hindari subtotal/pajak/kembalian).
    const totalKey = /(grand\s*total|total|sub\s*total|tagihan|jumlah\s*(bayar|total)?|pembayaran|amount|nominal)/i;
    let bestTotal = null, bestPrio = -1;
    for (const line of lines) {
      if (!totalKey.test(line)) continue;
      let prio = 1;
      if (/sub\s*total/i.test(line)) prio = 0;
      else if (/grand\s*total/i.test(line)) prio = 3;
      else if (/total/i.test(line)) prio = 2;
      // Pemisah ribuan bisa titik, koma, atau spasi (mis. "Rp.77 000").
      for (const m of line.matchAll(/\d{1,3}(?:[.,\s]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/g)) {
        const v = Utils.parsePrice(m[0]);
        if (v == null || v < HARGA_MIN || v > HARGA_MAX) continue;
        if (prio > bestPrio || (prio === bestPrio && (bestTotal == null || v > bestTotal))) {
          bestPrio = prio; bestTotal = v;
        }
      }
    }
    result.total = bestTotal;

    // Nama toko — tulisan paling besar di bagian atas, atau skor baris awal
    result.merchant = pickMerchant(raw, layoutLines);

    // Item — baris "nama ... harga" tanpa kata kunci total/EDC.
    // Kata kunci dibuang diperluas ke metadata EDC (#5): batch/trace/ref/appr/
    // merch/pan/rrn/card/issuer/tid/mid/dll.
    const skipItem = /(total|sub\s*total|grand|bayar|kembali|tunai|debit|kredit|credit|qris|transfer|change|payment|pembayaran|diskon|discount|pajak|ppn|dpp|service|charge|uang\s*muka|batch|trace|ref\.?no|\bref\b|appr|approval|merch|pan\b|pan#|nouc|card|issuer|rrn|tid\b|mid\b|terminal|acquirer|signature|cardholder|saldo|balance|kartu)/i;
    const edc = /(signature\s+not\s+required|cardholder\s*copy|ap+p?r(oval)?\s*code|\btrace\s*(no|nd|nu|:)|batch\s*[:#]|\bpan\b|pan#|\brrn\b|merch(ant)?\s*id|terminal\s*id)/i.test(raw);
    for (const line of lines) {
      if (skipItem.test(line)) continue;
      if (line === result.merchant) continue;
      if (matchDate(line)) continue;
      let s = line.replace(/^\s*\d+\s*[xX*]\s*/, '').replace(/\s*@\s*[\d.,]+\s*$/, '');
      if (!s) continue;
      const m = s.match(/^(.*?)\s*((?:rp\.?\s*)?\d[\d.,]*)$/);
      if (!m) continue;
      const nama = m[1].trim();
      const harga = Utils.parsePrice(m[2]);
      if (nama.length < 2 || nama.length > 48) continue;
      if (harga == null || harga < HARGA_MIN || harga > HARGA_MAX) continue;
      if (/^\d{1,2}[:.]\d{2}\s*$/.test(nama)) continue; // jam (12:30)
      // Tolak nomor panjang tanpa pemisah ribuan (PAN/no. referensi) sebagai harga.
      if (/\d{12,}/.test(m[2].replace(/[.,\s]/g, ''))) continue;
      // Nama yang nyaris hanya angka (metadata) bukan nama item.
      if ((nama.match(/[A-Za-z]/g) || []).length < 2) continue;
      result.items.push({ nama, harga });
      if (result.items.length >= 40) break;
    }
    // Struk pembayaran kartu/EDC memang tidak punya daftar item belanja.
    if (edc) result.items = [];

    return result;
  }

  return {
    loadOpenCV, loadTesseract,
    fileToCanvas, downscale, prepareForOcr,
    detectAndWarp, binarize, prepareReceiptVision,
    ocr, ocrBest, parseReceiptText, matchDate,
    pickMerchant, pickMerchantFromVariants
  };
})();
