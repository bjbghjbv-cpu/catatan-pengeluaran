/* ============================================================
   main.js — aplikasi Catatan Pengeluaran Bulanan
   ============================================================ */
'use strict';

(() => {

  /* ---------- Konstanta & state ---------- */

  const KATEGORI = [
    { key: 'makanan', label: 'MAKANAN' },
    { key: 'belanja', label: 'BELANJA BULANAN' },
    { key: 'transportasi', label: 'TRANSPORTASI' },
    { key: 'kesehatan', label: 'KESEHATAN' },
    { key: 'lainnya', label: 'LAINNYA' }
  ];

  const kategoriLabel = key => {
    const f = KATEGORI.find(k => k.key === key);
    return f ? f.label : String(key || '');
  };

  const ARROW_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h15"/><path d="M13 6l6 6-6 6"/></svg>';
  const X_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  let entries = Store.load();
  let currentMonth = Utils.monthKey(new Date());
  let view = 'beranda';
  let captureToken = 0;   // membatalkan pipeline yang sudah tidak relevan
  let liveStream = null;
  let lastCanvas = null;  // canvas terakhir yang sedang diproses

  // Status pemrosesan (ticker & bilah progres)
  let procTicker = null;
  let procT0 = 0;
  let procPhase = '';        // 'cv-download' | 'cv-compile' | 'ocr'
  let procCvPct = null;      // 0-1 bila progres unduhan diketahui
  let procCvWorker = false;  // true bila vision diproses di worker (UI tidak beku)
  let procOcrLabel = '';     // teks status OCR terakhir
  let procOcrPct = null;     // 0-1 progres OCR terakhir
  let fastMode = false;      // mode cepat: lewati computer vision

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ---------- Toast ---------- */

  let toastTimer = null;
  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = String(msg || '').replace(/^●\s*/, '');
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  /* ---------- Scroll lock ---------- */

  function syncScrollLock() {
    const overlayOpen = !$('#captureOverlay').classList.contains('hidden');
    const modalOpen = !$('#editModal').classList.contains('hidden');
    document.body.classList.toggle('no-scroll', overlayOpen || modalOpen);
  }

  /** Batasi durasi sebuah promise — bila lewat batas, lempar error. */
  function withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message || 'Waktu habis')), ms);
      promise.then(
        v => { clearTimeout(timer); resolve(v); },
        e => { clearTimeout(timer); reject(e); }
      );
    });
  }

  /* ---------- Ticker status pemrosesan ---------- */

  function stopProcTicker() {
    if (procTicker) { clearInterval(procTicker); procTicker = null; }
  }

  function startProcTicker() {
    stopProcTicker();
    procT0 = Date.now();
    procTicker = setInterval(refreshProcStatus, 1000);
  }

  function elapsedText() {
    const secs = Math.floor((Date.now() - procT0) / 1000);
    return Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
  }

  function refreshProcStatus() {
    const stage = $('#stageProcess');
    const status = $('#procStatus');
    const bar = $('#procBarFill');
    if (!stage || stage.classList.contains('hidden')) { stopProcTicker(); return; }
    let text = '';
    if (procPhase === 'cv-download') {
      if (procCvPct != null) {
        text = 'Mengunduh mesin computer vision… ' + Math.round(procCvPct * 100) + '%  (' + elapsedText() + ')';
        if (bar) { bar.classList.remove('indeterminate'); bar.style.width = Math.round(procCvPct * 100) + '%'; }
      } else {
        text = 'Mengunduh & menyusun mesin computer vision… (' + elapsedText() + ')';
        if (bar) { bar.classList.add('indeterminate'); bar.style.width = ''; }
      }
    } else if (procPhase === 'cv-compile') {
      text = procCvWorker
        ? 'Menyiapkan mesin computer vision di latar belakang… (' + elapsedText() + ') — halaman tetap bisa dipakai'
        : 'Menyusun mesin computer vision… bisa 1–2 menit (' + elapsedText() + ')';
      if (bar) { bar.classList.add('indeterminate'); bar.style.width = ''; }
    } else if (procPhase === 'ocr') {
      text = procOcrLabel || 'Membaca teks struk…';
      if (procOcrPct != null) text += ' ' + Math.round(procOcrPct * 100) + '%';
      text += ' (' + elapsedText() + ')';
      if (bar) {
        if (procOcrPct != null) { bar.classList.remove('indeterminate'); bar.style.width = Math.round(procOcrPct * 100) + '%'; }
        else bar.classList.add('indeterminate');
      }
    }
    if (status && text) status.textContent = text;
  }

  /* ---------- Navigasi antar layar ---------- */

  function setView(v) {
    view = v;
    $('#viewBeranda').classList.toggle('hidden', v !== 'beranda');
    $('#viewRingkasan').classList.toggle('hidden', v !== 'ringkasan');
    $('#navBeranda').classList.toggle('is-active', v === 'beranda');
    $('#navRingkasan').classList.toggle('is-active', v === 'ringkasan');
    window.scrollTo({ top: 0 });
  }

  function shiftMonth(delta) {
    const parts = currentMonth.split('-').map(Number);
    const d = new Date(parts[0], parts[1] - 1 + delta, 1);
    currentMonth = d.getFullYear() + '-' + Utils.pad(d.getMonth() + 1);
    render();
  }

  /* ---------- Render ---------- */

  function entriesForMonth() {
    return entries
      .filter(e => (e.tanggal || '').slice(0, 7) === currentMonth)
      .sort((a, b) =>
        (b.tanggal || '').localeCompare(a.tanggal || '') ||
        (b.createdAt || '').localeCompare(a.createdAt || '')
      );
  }

  function txnRowHTML(e) {
    const n = (e.items || []).length;
    return '<li>' +
      '<button class="txn-row" data-id="' + Utils.esc(e.id) + '">' +
        '<span class="txn-left">' +
          '<span class="badge">' + Utils.esc(kategoriLabel(e.kategori)) + '</span>' +
          '<span class="txn-merchant">' + Utils.esc(e.merchant) + '</span>' +
          '<span class="txn-meta">' + Utils.formatTanggal(e.tanggal) + (n ? ' · ' + n + ' item' : '') + '</span>' +
        '</span>' +
        '<span class="txn-amount">' + Utils.formatRupiah(e.total) + '</span>' +
      '</button>' +
    '</li>';
  }

  function render() {
    const monthEntries = entriesForMonth();
    const total = monthEntries.reduce((a, e) => a + (+e.total || 0), 0);

    // Beranda
    $('#heroTotal').textContent = Utils.formatRupiah(total);
    $('#monthTitle').textContent = Utils.formatBulanLabel(currentMonth);
    $('#txnList').innerHTML = monthEntries.map(txnRowHTML).join('');
    $('#emptyState').classList.toggle('hidden', monthEntries.length > 0);

    // Ringkasan
    $('#monthTitleR').textContent = Utils.formatBulanLabel(currentMonth);
    $('#summaryTotal').textContent = Utils.formatRupiah(total);
    const itemCount = monthEntries.reduce((a, e) => a + (e.items || []).length, 0);
    $('#summaryMeta').textContent = monthEntries.length + ' transaksi · ' + itemCount + ' item';

    const sums = KATEGORI.map(k => ({
      key: k.key,
      label: k.label,
      sum: monthEntries.filter(e => e.kategori === k.key).reduce((a, e) => a + (+e.total || 0), 0)
    }));
    const maxSum = Math.max(...sums.map(s => s.sum), 0);
    $('#catList').innerHTML = sums.map(s => {
      const pct = total > 0 ? Math.round(s.sum / total * 100) : 0;
      const top = s.sum > 0 && s.sum === maxSum ? ' top' : '';
      return '<div class="cat-row' + top + '">' +
        '<div class="cat-head">' +
          '<span class="badge">' + s.label + '</span>' +
          '<span class="cat-meta"><span class="cat-amt">' + Utils.formatRupiah(s.sum) + '</span>' +
          '<span class="cat-pct">' + pct + '%</span></span>' +
        '</div>' +
        '<div class="cat-bar"><div class="cat-fill" style="width:' + pct + '%"></div></div>' +
      '</div>';
    }).join('');
  }

  /* ---------- Form entri (dipakai overlay konfirmasi & modal edit) ---------- */

  function buildEntryForm(mount, entry, hooks) {
    const e = entry || {};
    mount.innerHTML =
      '<form class="entry-form" novalidate>' +
        '<div class="field">' +
          '<label>Nama toko</label>' +
          '<input class="input f-merchant" placeholder="mis. SUPER INDO" value="' + Utils.esc(e.merchant || '') + '" aria-label="Nama toko" autocomplete="off">' +
        '</div>' +
        '<div class="field">' +
          '<label>Tanggal</label>' +
          // Tanggal TIDAK lagi diisi diam-diam dengan hari ini (#3): biarkan
          // kosong bila hasil OCR tak terbaca, agar pengguna melihat & mengoreksi.
          '<input class="input f-tanggal" type="date" value="' + Utils.esc(e.tanggal || '') + '" aria-label="Tanggal">' +
        '</div>' +
        '<div class="field">' +
          '<label>Kategori</label>' +
          '<div class="chip-row f-kategori">' +
            KATEGORI.map(k => '<button type="button" class="chip" data-kat="' + k.key + '">' + k.label + '</button>').join('') +
          '</div>' +
        '</div>' +
        '<div class="field">' +
          '<label>Rincian item</label>' +
          '<div class="items-list f-items"></div>' +
          '<button type="button" class="btn-add f-add-item">+ TAMBAH ITEM</button>' +
        '</div>' +
        '<div class="field">' +
          '<label>Total</label>' +
          '<div class="total-row">' +
            '<span class="total-prefix">Rp</span>' +
            '<input class="input total-input f-total" inputmode="decimal" placeholder="0" value="' + (e.total ? Utils.priceDigits(e.total) : '') + '" aria-label="Total">' +
            '<button type="button" class="btn-add f-sum-total" title="Samakan dengan jumlah item">= JUMLAH ITEM</button>' +
          '</div>' +
        '</div>' +
        '<div class="form-actions">' +
          (hooks.onDelete ? '<button type="button" class="btn btn-ghost f-delete">HAPUS</button>' : '') +
          '<span class="spacer"></span>' +
          '<button type="button" class="btn btn-ghost f-cancel">BATAL</button>' +
          '<button type="submit" class="btn btn-primary"><span class="btn-label">SIMPAN</span><span class="btn-circle">' + ARROW_SVG + '</span></button>' +
        '</div>' +
      '</form>';

    const form = mount.querySelector('.entry-form');
    const state = {
      kategori: e.kategori || 'lainnya',
      totalTouched: !!e.total,
      items: (e.items && e.items.length)
        ? e.items.map(i => ({ nama: i.nama || '', harga: i.harga || null }))
        : [{ nama: '', harga: null }]
    };

    // Chip kategori
    const chips = $$('.chip', form);
    chips.forEach(c => c.addEventListener('click', () => {
      chips.forEach(x => x.classList.remove('active'));
      c.classList.add('active');
      state.kategori = c.dataset.kat;
    }));
    const initial = form.querySelector('.chip[data-kat="' + state.kategori + '"]');
    if (initial) initial.classList.add('active');

    // Item
    const itemsList = $('.f-items', form);
    const itemRowHTML = it =>
      '<div class="item-row">' +
        '<input class="input" placeholder="Nama item" value="' + Utils.esc(it.nama || '') + '" aria-label="Nama item">' +
        '<input class="input input-price" inputmode="decimal" placeholder="0" value="' + (it.harga ? Utils.priceDigits(it.harga) : '') + '" aria-label="Harga">' +
        '<button type="button" class="item-del" aria-label="Hapus item">' + X_SVG + '</button>' +
      '</div>';

    const renderItems = () => { itemsList.innerHTML = state.items.map(itemRowHTML).join(''); };
    const collectItems = () => $$('.item-row', itemsList).map(row => ({
      nama: row.querySelectorAll('.input')[0].value.trim(),
      harga: Utils.parsePrice(row.querySelectorAll('.input')[1].value)
    })).filter(i => i.nama && i.harga != null && i.harga >= 0);
    const sumItems = () => collectItems().reduce((a, i) => a + i.harga, 0);

    renderItems();

    $('.f-add-item', form).addEventListener('click', () => {
      state.items.push({ nama: '', harga: null });
      renderItems();
    });
    itemsList.addEventListener('click', ev => {
      const del = ev.target.closest('.item-del');
      if (!del) return;
      del.closest('.item-row').remove();
      refreshTotal();
    });
    itemsList.addEventListener('input', refreshTotal);

    // Total
    const totalEl = $('.f-total', form);
    totalEl.addEventListener('input', () => { state.totalTouched = totalEl.value.trim() !== ''; });
    function refreshTotal() {
      if (!state.totalTouched) totalEl.value = Utils.priceDigits(sumItems());
    }
    $('.f-sum-total', form).addEventListener('click', () => {
      state.totalTouched = true;
      totalEl.value = Utils.priceDigits(sumItems());
    });

    // Batal
    const cancelBtn = $('.f-cancel', form);
    if (cancelBtn) cancelBtn.addEventListener('click', () => hooks.onCancel && hooks.onCancel());

    // Hapus (konfirmasi dua klik)
    const delBtn = $('.f-delete', form);
    if (delBtn) {
      let disarmTimer = null;
      delBtn.addEventListener('click', () => {
        if (!delBtn.dataset.armed) {
          delBtn.dataset.armed = '1';
          delBtn.textContent = 'YAKIN — KLIK LAGI';
          clearTimeout(disarmTimer);
          disarmTimer = setTimeout(() => {
            delBtn.dataset.armed = '';
            delBtn.textContent = 'HAPUS';
          }, 2600);
        } else {
          clearTimeout(disarmTimer);
          hooks.onDelete && hooks.onDelete();
        }
      });
    }

    // Simpan
    form.addEventListener('submit', ev => {
      ev.preventDefault();
      const data = {
        merchant: $('.f-merchant', form).value.trim(),
        tanggal: $('.f-tanggal', form).value || Utils.todayISO(),
        kategori: state.kategori,
        items: collectItems(),
        total: Utils.parsePrice(totalEl.value)
      };
      if (hooks.onSave) hooks.onSave(data);
    });
  }

  /* ---------- Simpan / ubah / hapus ---------- */

  function saveFromForm(data, entryId) {
    if (!data.merchant) { toast('Nama toko wajib diisi'); return false; }
    let total = data.total;
    const itemSum = data.items.reduce((a, i) => a + i.harga, 0);
    if (total == null || total <= 0) total = itemSum;
    if (!(total > 0)) { toast('Isi total atau minimal satu item'); return false; }
    let items = data.items;
    if (!items.length) items = [{ nama: 'Belanja', harga: total }];

    if (entryId) {
      const e = entries.find(x => x.id === entryId);
      if (!e) { toast('Transaksi tidak ditemukan'); return false; }
      Object.assign(e, { merchant: data.merchant, tanggal: data.tanggal, kategori: data.kategori, items, total });
    } else {
      entries.push({
        id: Utils.uid(),
        merchant: data.merchant,
        tanggal: data.tanggal,
        kategori: data.kategori,
        items,
        total,
        createdAt: new Date().toISOString()
      });
    }
    Store.save(entries);
    render();
    return true;
  }

  /* ---------- Modal edit / tambah manual ---------- */

  function openEdit(id) {
    const e = entries.find(x => x.id === id);
    if (!e) return;
    $('#editModalTitle').textContent = 'EDIT TRANSAKSI';
    buildEntryForm($('#editFormWrap'), e, {
      onSave: data => { if (saveFromForm(data, id)) { toast('● DIUBAH'); closeModal(); } },
      onCancel: closeModal,
      onDelete: () => {
        entries = entries.filter(x => x.id !== id);
        Store.save(entries);
        closeModal();
        render();
        toast('● DIHAPUS');
      }
    });
    $('#editModal').classList.remove('hidden');
    syncScrollLock();
  }

  function openManual() {
    $('#editModalTitle').textContent = 'TAMBAH MANUAL';
    // Untuk input manual, isi tanggal hari ini sebagai nilai awal yang praktis.
    buildEntryForm($('#editFormWrap'), { tanggal: Utils.todayISO() }, {
      onSave: data => { if (saveFromForm(data, null)) { toast('● TERSIMPAN'); closeModal(); } },
      onCancel: closeModal
    });
    $('#editModal').classList.remove('hidden');
    syncScrollLock();
  }

  function closeModal() {
    $('#editModal').classList.add('hidden');
    syncScrollLock();
  }

  /* ---------- Overlay ambil foto ---------- */

  function openCapture(stage) {
    captureToken++;
    $('#captureOverlay').classList.remove('hidden');
    syncScrollLock();
    setStage(stage || 'pick');
  }

  function closeCapture() {
    captureToken++;
    stopLiveCam();
    $('#captureOverlay').classList.add('hidden');
    syncScrollLock();
  }

  function setStage(name) {
    $$('.stage').forEach(s => s.classList.add('hidden'));
    const map = { pick: '#stagePick', live: '#stageLive', process: '#stageProcess', confirm: '#stageConfirm' };
    if (map[name]) $(map[name]).classList.remove('hidden');
    const labels = {
      pick: 'LANGKAH 1 — FOTO',
      live: 'LANGKAH 1 — KAMERA LIVE',
      process: 'LANGKAH 2 — MEMPROSES',
      confirm: 'LANGKAH 3 — KONFIRMASI'
    };
    $('#captureStepLabel').textContent = labels[name] || '';
    if (name !== 'live') stopLiveCam();
    if (name !== 'process') stopProcTicker();
    $('#captureOverlay').scrollTop = 0;
  }

  function setStep(id, state) {
    const el = $('#' + id);
    if (!el) return; // aman: elemen tidak ditemukan
    el.classList.remove('active', 'done');
    if (state === 'active') el.classList.add('active');
    else if (state === 'done') el.classList.add('done');
  }

  /* ---------- Kamera live (getUserMedia) ---------- */

  async function startLiveCam() {
    stopLiveCam();
    if (!window.isSecureContext) {
      toast('Kamera live butuh koneksi aman (HTTPS) — di HP gunakan tombol AMBIL FOTO');
      setStage('pick');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Kamera tidak tersedia di browser ini');
      setStage('pick');
      return;
    }
    try {
      liveStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1600 } },
        audio: false
      });
    } catch (e1) {
      try {
        liveStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } catch (e2) {
        toast('Izin kamera ditolak — gunakan tombol AMBIL FOTO');
        setStage('pick');
        return;
      }
    }
    const video = $('#camVideo');
    video.srcObject = liveStream;
    video.play().catch(() => {});
  }

  function stopLiveCam() {
    if (liveStream) {
      liveStream.getTracks().forEach(t => t.stop());
      liveStream = null;
    }
    const v = $('#camVideo');
    if (v) v.srcObject = null;
  }

  function shootFrame() {
    const video = $('#camVideo');
    if (!video.videoWidth) { toast('Kamera belum siap'); return; }
    let facing = 'environment';
    if (liveStream && liveStream.getVideoTracks()[0] && liveStream.getVideoTracks()[0].getSettings) {
      facing = liveStream.getVideoTracks()[0].getSettings().facingMode || 'environment';
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (facing === 'user') { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, 0, 0);
    stopLiveCam();
    handleCanvas(canvas);
  }

  /* ---------- Pipeline: file/canvas -> CV -> OCR -> form ---------- */

  function handleFile(file) {
    if (!file) return;
    const ok = (file.type && file.type.startsWith('image/')) ||
      file.type === 'application/pdf' ||
      /\.pdf$/i.test(file.name || '');
    if (!ok) { toast('Format tidak didukung — gunakan JPG, PNG, atau PDF'); return; }
    openCapture('process');
    const token = captureToken;
    withTimeout(Vision.fileToCanvas(file), 90000, 'Foto terlalu lama dibaca')
      .then(canvas => {
        if (token !== captureToken) return;
        runPipeline(canvas, token);
      })
      .catch(err => {
        if (token !== captureToken) return;
        toast('Foto gagal dibaca: ' + ((err && err.message) || 'format tidak dikenal'));
        setStage('pick');
      });
  }

  function handleCanvas(canvas) {
    openCapture('process');
    runPipeline(canvas, captureToken);
  }

  async function runPipeline(canvas, token) {
    lastCanvas = canvas;
    console.info('[pipeline] mulai memproses foto');
    $('#procPreview').src = canvas.toDataURL();
    setStep('stepDetect', 'active');
    setStep('stepOcr', '');
    $('#ocrProgress').textContent = '';
    procPhase = 'cv-download';
    procCvPct = null;
    procOcrLabel = '';
    procOcrPct = null;
    startProcTicker();
    refreshProcStatus();

    const scaled = Vision.downscale(canvas, 1800);
    let result = { scan: scaled, quad: null, note: 'Struk tidak terdeteksi — memakai foto penuh.' };

    const cvT0 = performance.now();
    if (fastMode) {
      console.info('[pipeline] mode cepat — computer vision dilewati');
      result = { scan: scaled, quad: null, note: 'Mode cepat aktif — struk tidak dideteksi/diluruskan.' };
    } else {
      try {
        const r = await Vision.prepareReceiptVision(scaled, p => {
          if (p && p.phase === 'compile') {
            procPhase = 'cv-compile';
            procCvWorker = !!p.worker;
            procCvPct = null;
          } else {
            procPhase = 'cv-download';
            procCvPct = (p && p.percent != null) ? p.percent : null;
          }
          refreshProcStatus();
        });
        if (r && r.scan) result = r;
        console.info('[pipeline] computer vision selesai dalam ' + Math.round(performance.now() - cvT0) + ' ms');
      } catch (err) {
        console.warn('[pipeline] computer vision gagal:', err);
        result = { scan: scaled, quad: null, note: 'Mesin computer vision gagal dimuat — memakai foto penuh.' };
      }
    }

    if (token !== captureToken) return;
    setStep('stepDetect', 'done');
    setStep('stepOcr', 'active');
    procPhase = 'ocr';
    procOcrLabel = result.note || '';
    procOcrPct = null;

    const settings = Store.loadSettings();
    const isCloud = settings.provider === 'google' || settings.provider === 'azure';
    if (isCloud) procOcrLabel = 'Memproses di cloud…';
    refreshProcStatus();
    const ocrProgressCb = (p, status) => {
      if (p != null && p <= 1) {
        procOcrPct = p;
        $('#ocrProgress').textContent = Math.round(p * 100) + '%';
      }
      const label = ocrStageText(status);
      if (label) procOcrLabel = label;
      refreshProcStatus();
    };
    let text = '';
    let layoutLines = [];
    let ocrOk = true;
    let conf1 = null;
    let ocrVariants = [];
    console.info('[pipeline] mulai OCR');
    try {
      if (isCloud) {
        // Mode cloud: satu panggilan pada hasil scan.
        const ocrRes = await withTimeout(
          Vision.ocr(Vision.prepareForOcr(result.scan), settings, ocrProgressCb),
          180000,
          'OCR terlalu lama'
        );
        text = (ocrRes && ocrRes.text) ? ocrRes.text : '';
        layoutLines = (ocrRes && Array.isArray(ocrRes.lines)) ? ocrRes.lines : [];
        conf1 = (ocrRes && typeof ocrRes.confidence === 'number' && !isNaN(ocrRes.confidence))
          ? ocrRes.confidence : null;
      } else {
        // OCR beberapa sumber: hasil warp/potong + FOTO ASLI (+ biner). Pilih
        // hasil terbaik dengan skor gabungan field, bukan confidence mentah (#2).
        const sources = [{ canvas: result.scan, tag: result.quad ? 'warp' : 'potong' }];
        if (scaled && scaled !== result.scan) sources.push({ canvas: scaled, tag: 'asli' });
        if (result.scanBin && result.scanBin !== result.scan) sources.push({ canvas: result.scanBin, tag: 'biner' });
        const best = await withTimeout(
          Vision.ocrBest(sources, settings, ocrProgressCb),
          300000,
          'OCR terlalu lama'
        );
        text = (best && best.text) ? best.text : '';
        layoutLines = (best && Array.isArray(best.lines)) ? best.lines : [];
        conf1 = (best && typeof best.confidence === 'number' && !isNaN(best.confidence)) ? best.confidence : null;
        ocrVariants = (best && best.variants) || [];
      }
      console.info('[pipeline] OCR selesai, panjang teks:', text.length, 'conf:', conf1);
    } catch (err) {
      console.warn('OCR gagal:', err);
      ocrOk = false;
    }

    if (token !== captureToken) return;
    setStep('stepOcr', 'done');
    $('#ocrProgress').textContent = '';
    stopProcTicker();
    const procBarFill = $('#procBarFill');
    if (procBarFill) { procBarFill.classList.remove('indeterminate'); procBarFill.style.width = '100%'; }
    if (!ocrOk) toast('OCR gagal atau lambat — silakan isi manual');

    const parsed = Vision.parseReceiptText(text, layoutLines);
    // Bila sumber terbaik tak menghasilkan nama toko yang layak, ambil dari
    // varian OCR lain (mis. PSM berbeda membaca nama brand lebih baik).
    if ((!parsed.merchant || parsed.merchant.replace(/[^A-Za-z]/g, '').length < 3) && ocrVariants.length) {
      const alt = Vision.pickMerchantFromVariants(ocrVariants);
      if (alt) parsed.merchant = alt;
    }
    showConfirm({ orig: canvas, scan: result.scan, quad: result.quad, note: result.note, text, ocrFailed: !ocrOk, parsed });
  }

  function guessKategori(merchant, items) {
    const s = (merchant + ' ' + (items || []).map(i => i.nama).join(' ')).toLowerCase();
    if (/(mart|indo|alfa|super|swalayan|minimarket|grosir|toserba|hiper)/.test(s)) return 'belanja';
    if (/(apotek|farmasi|klinik|obat|dokter|rumah sakit|lab)/.test(s)) return 'kesehatan';
    if (/(bensin|pertamina|shell|vivo|spbu|gojek|grab|ojek|taksi|tiket|tol\b|parkir|kereta|damri|trans)/.test(s)) return 'transportasi';
    if (/(resto|restaur|kfc|mcd|burger|pizza|warung|cafe|café|kopi|bakso|soto|nasi|martabak|roti|fried)/.test(s)) return 'makanan';
    return 'lainnya';
  }

  function ocrStageText(status) {
    const s = String(status || '').toLowerCase();
    if (!s) return '';
    if (s.includes('core') || s.includes('initializing tesseract')) return 'Menyiapkan mesin OCR…';
    if (s.includes('language') || s.includes('traineddata')) return 'Mengunduh data bahasa Indonesia + Inggris (sekali saja)…';
    if (s.includes('api')) return 'Menyiapkan…';
    if (s.includes('recogniz')) return 'Membaca teks struk…';
    return '';
  }

  function drawQuad(quad) {
    const svg = $('#quadOverlay');
    svg.innerHTML = '';
    if (!quad || quad.length < 4) return;
    const NS = 'http://www.w3.org/2000/svg';
    const pts = quad.map(p => (p.x * 100).toFixed(2) + ',' + (p.y * 100).toFixed(2));
    const poly = document.createElementNS(NS, 'polygon');
    poly.setAttribute('points', pts.join(' '));
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', '#C9F24D');
    poly.setAttribute('stroke-width', '0.7');
    poly.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(poly);
    quad.forEach(p => {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', (p.x * 100).toFixed(2));
      c.setAttribute('cy', (p.y * 100).toFixed(2));
      c.setAttribute('r', '1.6');
      c.setAttribute('fill', '#C9F24D');
      svg.appendChild(c);
    });
  }

  function showConfirm(ctx) {
    $('#scanPreview').src = ctx.scan.toDataURL();
    $('#origPreview').src = ctx.orig.toDataURL();
    drawQuad(ctx.quad);
    $('#scanHint').textContent = ctx.note || '';

    const p = ctx.parsed;
    $('#ocrNotice').textContent = (ctx.text && ctx.text.trim())
      ? ''
      : (ctx.ocrFailed
        ? 'OCR gagal atau terlalu lambat — silakan isi manual di samping.'
        : 'OCR tidak menemukan teks — silakan isi manual di samping.');
    $('#rawOcr').textContent = ctx.text || '(kosong)';

    const draft = {
      merchant: p.merchant || '',
      // Tanggal kosong bila OCR gagal membaca (#3) — jangan menutupi bug
      // dengan tanggal hari ini.
      tanggal: p.tanggal || '',
      kategori: guessKategori(p.merchant, p.items),
      items: (p.items && p.items.length) ? p.items : [],
      total: p.total != null ? p.total : null
    };

    buildEntryForm($('#confirmFormWrap'), draft, {
      onSave: data => { if (saveFromForm(data, null)) { toast('● TERSIMPAN'); closeCapture(); } },
      onCancel: closeCapture
    });

    setStage('confirm');
  }

  /** Lewati pemindaian — langsung isi manual memakai foto apa adanya. */
  function skipScan() {
    if (!lastCanvas) { toast('Foto masih disiapkan…'); return; }
    captureToken++;
    showConfirm({
      orig: lastCanvas,
      scan: lastCanvas,
      quad: null,
      note: 'Pemindaian dilewati — isi manual.',
      text: '',
      ocrFailed: false,
      parsed: { merchant: '', tanggal: null, items: [], total: null }
    });
  }

  /* ---------- Ekspor / impor ---------- */

  function importJSON(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data)) throw new Error('bukan array');
        const map = new Map(entries.map(e => [e.id, e]));
        let added = 0;
        data.forEach(raw => {
          if (!raw || typeof raw !== 'object') return;
          const id = String(raw.id || Utils.uid());
          const total = Number(raw.total) || 0;
          if (!raw.merchant || total <= 0) return;
          const e = {
            id,
            merchant: String(raw.merchant),
            tanggal: String(raw.tanggal || Utils.todayISO()),
            kategori: KATEGORI.some(k => k.key === raw.kategori) ? raw.kategori : 'lainnya',
            items: Array.isArray(raw.items)
              ? raw.items.map(i => ({ nama: String(i.nama || ''), harga: Number(i.harga) || 0 })).filter(i => i.nama)
              : [],
            total,
            createdAt: raw.createdAt || new Date().toISOString()
          };
          if (!map.has(id)) added++;
          map.set(id, e);
        });
        entries = Array.from(map.values());
        Store.save(entries);
        render();
        toast('● DIIMPOR: ' + data.length + ' BARIS');
      } catch (err) {
        toast('File JSON tidak valid');
      }
    };
    reader.onerror = () => toast('File gagal dibaca');
    reader.readAsText(file, 'utf-8');
  }

  /* ---------- Pengaturan cloud OCR ---------- */

  function renderCloudFields() {
    const azure = $('#cloudProvider').value === 'azure';
    $('#cloudEndpoint').classList.toggle('hidden', !azure);
  }

  function saveCloudSettings() {
    const provider = $('#cloudProvider').value;
    const key = $('#cloudKey').value.trim();
    const endpoint = $('#cloudEndpoint').value.trim();
    if (provider !== 'none' && !key) { toast('Kunci API wajib diisi'); return; }
    if (provider === 'azure' && !endpoint) { toast('Endpoint Azure wajib diisi'); return; }
    Store.saveSettings({ provider, key, endpoint });
    renderCloudStatus();
    toast('● PENGATURAN DISIMPAN');
  }

  function renderCloudStatus() {
    const s = Store.loadSettings();
    let msg = 'Mode aktif: Tesseract lokal — gratis, berjalan penuh di perangkat.';
    if (s.provider === 'google' && s.key) msg = 'Mode aktif: Google Cloud Vision.';
    if (s.provider === 'azure' && s.key && s.endpoint) msg = 'Mode aktif: Azure Computer Vision.';
    $('#cloudStatus').textContent = msg;
  }

  /* ---------- Inisialisasi event ---------- */

  function init() {
    // Header & navigasi
    $('#btnWordmark').addEventListener('click', () => setView('beranda'));
    $('#navBeranda').addEventListener('click', () => setView('beranda'));
    $('#navRingkasan').addEventListener('click', () => setView('ringkasan'));
    $('#btnCameraHeader').addEventListener('click', () => openCapture('pick'));

    // Beranda
    $('#btnCaptureHero').addEventListener('click', () => { openCapture('pick'); $('#inputCamera').click(); });
    $('#btnManualHero').addEventListener('click', openManual);
    $('#btnEmptyAdd').addEventListener('click', openManual);
    $('#monthPrev').addEventListener('click', () => shiftMonth(-1));
    $('#monthNext').addEventListener('click', () => shiftMonth(1));
    $('#monthPrevR').addEventListener('click', () => shiftMonth(-1));
    $('#monthNextR').addEventListener('click', () => shiftMonth(1));
    $('#txnList').addEventListener('click', ev => {
      const row = ev.target.closest('.txn-row');
      if (row) openEdit(row.dataset.id);
    });

    // Overlay ambil foto
    $('#btnCaptureClose').addEventListener('click', closeCapture);
    $('#btnTakePhoto').addEventListener('click', () => $('#inputCamera').click());
    $('#btnGallery').addEventListener('click', () => $('#inputGallery').click());
    $('#dropzone').addEventListener('click', () => $('#inputGallery').click());
    $('#btnLiveCam').addEventListener('click', () => { openCapture('live'); startLiveCam(); });
    $('#btnLiveCancel').addEventListener('click', () => setStage('pick'));
    $('#btnShutter').addEventListener('click', shootFrame);
    $('#btnRetake').addEventListener('click', () => setStage('pick'));
    $('#btnSkipScan').addEventListener('click', skipScan);
    $('#btnFastMode').addEventListener('click', () => {
      fastMode = !fastMode;
      $('#btnFastMode').classList.toggle('active', fastMode);
      toast(fastMode ? 'MODE CEPAT AKTIF' : 'MODE CEPAT NONAKTIF');
    });

    // Input file
    $('#inputCamera').addEventListener('change', ev => {
      const f = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (f) handleFile(f);
    });
    $('#inputGallery').addEventListener('change', ev => {
      const f = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (f) handleFile(f);
    });

    // Drag & drop
    ['dragenter', 'dragover'].forEach(t =>
      $('#dropzone').addEventListener(t, ev => { ev.preventDefault(); $('#dropzone').classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(t =>
      $('#dropzone').addEventListener(t, ev => { ev.preventDefault(); $('#dropzone').classList.remove('drag'); }));
    $('#dropzone').addEventListener('drop', ev => {
      const f = ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (f) handleFile(f);
    });

    // Modal edit
    $('#btnEditClose').addEventListener('click', closeModal);
    $('#editModalBackdrop').addEventListener('click', closeModal);

    // Ringkasan: data
    $('#btnExportCSV').addEventListener('click', () => {
      if (!entries.length) { toast('Belum ada data untuk diekspor'); return; }
      Utils.download('pengeluaran.csv', Utils.toCSV(entries, kategoriLabel), 'text/csv;charset=utf-8');
      toast('● CSV DIUNDUH');
    });
    $('#btnExportJSON').addEventListener('click', () => {
      if (!entries.length) { toast('Belum ada data untuk diekspor'); return; }
      Utils.download('pengeluaran.json', JSON.stringify(entries, null, 2), 'application/json');
      toast('● JSON DIUNDUH');
    });
    $('#btnImportJSON').addEventListener('click', () => $('#importInput').click());
    $('#importInput').addEventListener('change', ev => {
      const f = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (f) importJSON(f);
    });

    // Ringkasan: cloud OCR
    const s = Store.loadSettings();
    if (s.provider) $('#cloudProvider').value = s.provider;
    $('#cloudKey').value = s.key || '';
    $('#cloudEndpoint').value = s.endpoint || '';
    $('#cloudProvider').addEventListener('change', renderCloudFields);
    $('#btnSaveCloud').addEventListener('click', saveCloudSettings);
    renderCloudFields();
    renderCloudStatus();

    // Escape
    document.addEventListener('keydown', ev => {
      if (ev.key !== 'Escape') return;
      if (!$('#captureOverlay').classList.contains('hidden')) closeCapture();
      else if (!$('#editModal').classList.contains('hidden')) closeModal();
    });

    render();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
