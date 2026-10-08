/* ============================================================
   utils.js — helper umum: format, parsing, CSV, unduhan
   ============================================================ */
'use strict';

const Utils = (() => {

  const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const BULAN_PANJANG = ['JANUARI', 'FEBRUARI', 'MARET', 'APRIL', 'MEI', 'JUNI', 'JULI', 'AGUSTUS', 'SEPTEMBER', 'OKTOBER', 'NOVEMBER', 'DESEMBER'];

  const pad = n => String(n).padStart(2, '0');

  /** Escape HTML agar aman dimasukkan ke innerHTML. */
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /** ID unik untuk entri. */
  function uid() {
    return (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
  }

  /** 12500 -> "Rp 12.500" (pemisah ribuan titik, gaya Indonesia). */
  function formatRupiah(n) {
    const v = Math.round((+n || 0) * 100) / 100;
    return 'Rp ' + v.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  /** 12500 -> "12.500" (angka saja, untuk isi input). */
  function priceDigits(n) {
    const v = Math.round((+n || 0) * 100) / 100;
    return v.toLocaleString('id-ID', { maximumFractionDigits: 2 });
  }

  /**
   * Parsing harga dari teks struk / input manual.
   * Menerima: "12.500", "12,500", "1.234,56", "12,50", "Rp12.500", "-5.000"
   * Aturan: pemisah titik/ribuan vs koma/desimal ditebak dari pola.
   */
  function parsePrice(str) {
    if (str == null) return null;
    let s = String(str).toLowerCase().replace(/rp\.?/g, '').replace(/[^\d.,-]/g, '');
    if (!s || !/\d/.test(s)) return null;
    const neg = s.startsWith('-');
    s = s.replace(/^-/, '').replace(/[.,]$/, '');
    if (!s) return null;

    let m;
    // 1.234,56 atau 1,234.56 — ribuan + desimal
    if ((m = s.match(/^(\d{1,3}(?:[.,]\d{3})+)[.,](\d{1,2})$/))) {
      const v = parseInt(m[1].replace(/[.,]/g, ''), 10) + parseInt(m[2], 10) / Math.pow(10, m[2].length);
      return neg ? -v : v;
    }
    // 12.500 / 12,500 — ribuan tanpa desimal
    if (/^\d{1,3}([.,]\d{3})+$/.test(s)) {
      const v = parseInt(s.replace(/[.,]/g, ''), 10);
      return neg ? -v : v;
    }
    // 12,50 / 12.50 — desimal sederhana
    if ((m = s.match(/^(\d+)[.,](\d{1,2})$/))) {
      const v = parseInt(m[1], 10) + parseInt(m[2], 10) / Math.pow(10, m[2].length);
      return neg ? -v : v;
    }
    const v = parseFloat(s.replace(/,/g, '.'));
    return isNaN(v) ? null : (neg ? -v : v);
  }

  /** Tanggal hari ini sebagai ISO "YYYY-MM-DD". */
  function todayISO() {
    const d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /** Kunci bulan "YYYY-MM" dari objek Date. */
  function monthKey(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
  }

  /** "2026-10-07" -> "7 Okt 2026". */
  function formatTanggal(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return iso;
    return d.getDate() + ' ' + BULAN[d.getMonth()] + ' ' + d.getFullYear();
  }

  /** "2026-10" -> "OKTOBER 2026". */
  function formatBulanLabel(ym) {
    const parts = String(ym || '').split('-').map(Number);
    if (parts.length < 2 || !parts[1]) return String(ym);
    return (BULAN_PANJANG[parts[1] - 1] || '') + ' ' + parts[0];
  }

  /** Unduh string sebagai file. */
  function download(name, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /** Ekspor entri ke CSV (delimiter ";", cocok untuk Excel Indonesia, ada BOM UTF-8). */
  function toCSV(list, kategoriLabel) {
    const escCsv = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const head = ['Tanggal', 'Kategori', 'Toko', 'Total', 'Item'];
    const rows = list.map(e => [
      e.tanggal,
      kategoriLabel(e.kategori),
      e.merchant,
      e.total,
      (e.items || []).map(i => i.nama + ' (' + i.harga + ')').join(' | ')
    ]);
    return '\uFEFF' + [head, ...rows].map(r => r.map(escCsv).join(';')).join('\r\n');
  }

  return {
    BULAN, BULAN_PANJANG, pad, esc, uid,
    formatRupiah, priceDigits, parsePrice,
    todayISO, monthKey, formatTanggal, formatBulanLabel,
    download, toCSV
  };
})();
