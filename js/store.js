/* ============================================================
   store.js — penyimpanan lokal (localStorage)
   Model entri:
   { id, merchant, tanggal (ISO YYYY-MM-DD), kategori, total,
     items: [{ nama, harga }], createdAt }
   ============================================================ */
'use strict';

const Store = (() => {

  const KEY = 'catatan-pengeluaran-entries-v1';
  const KEY_SETTINGS = 'catatan-pengeluaran-settings-v1';

  /** Muat semua entri. Selalu mengembalikan array valid. */
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter(e => e && typeof e === 'object' && e.id) : [];
    } catch (err) {
      console.warn('Gagal membaca localStorage:', err);
      return [];
    }
  }

  /** Simpan semua entri. */
  function save(list) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch (err) {
      console.warn('Gagal menyimpan ke localStorage:', err);
    }
  }

  /** Muat pengaturan (mode OCR cloud dll). */
  function loadSettings() {
    try {
      return JSON.parse(localStorage.getItem(KEY_SETTINGS)) || {};
    } catch (err) {
      return {};
    }
  }

  /** Simpan pengaturan. */
  function saveSettings(settings) {
    try {
      localStorage.setItem(KEY_SETTINGS, JSON.stringify(settings));
    } catch (err) {
      console.warn('Gagal menyimpan pengaturan:', err);
    }
  }

  return { load, save, loadSettings, saveSettings };
})();
