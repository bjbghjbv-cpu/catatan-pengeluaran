// ============================================================
// Harness reproduksi SUB-AGENT 1 (read-only terhadap kode app).
// Menjalankan aplikasi di Chrome headless via CDP, mengunggah
// struk_contoh.jpeg secara programatik, lalu merekam:
//   - seluruh console log halaman
//   - teks mentah OCR (#rawOcr), notice, note deteksi
//   - nilai form konfirmasi (merchant/tanggal/kategori/item/total)
//   - preview scan hasil warp
// Output: laporan/harness/hasil-repro.json + console.txt
// ============================================================
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_BIN || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP_URL = process.env.APP_URL || 'http://localhost:8080/';
const IMG = process.env.IMG || 'C:\\Users\\setia\\Downloads\\struk_contoh.jpeg';
const PORT = Number(process.env.CDP_PORT || 9333);
const MAX_WAIT_MS = Number(process.env.MAX_WAIT_MS || 300000);

const userDataDir = join(tmpdir(), 'cdp-struk-' + Date.now());
const consoleLines = [];
let ws, msgId = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function getJSON(path) {
  const resp = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return resp.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  mkdirSync(__dirname, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-dev-shm-usage',
    '--window-size=1400,1800',
    'about:blank'
  ], { stdio: 'ignore' });

  // Tunggu endpoint debugging siap
  let ver = null;
  for (let i = 0; i < 60; i++) {
    try { ver = await getJSON('/json/version'); break; } catch { await sleep(500); }
  }
  if (!ver) throw new Error('Chrome CDP tidak merespons');
  console.error('[harness] Chrome:', ver['Browser']);

  // Ambil target page
  let targets = await getJSON('/json/list');
  let page = targets.find(t => t.type === 'page');
  if (!page) {
    await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
    targets = await getJSON('/json/list');
    page = targets.find(t => t.type === 'page');
  }

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      const type = m.params.type;
      const text = (m.params.args || []).map(a => {
        if (a.value !== undefined) return String(a.value);
        if (a.description) return a.description;
        return a.type;
      }).join(' ');
      consoleLines.push(`[console.${type}] ${text}`);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      consoleLines.push('[exception] ' + (d.exception && d.exception.description || d.text));
    } else if (m.method === 'Log.entryAdded') {
      consoleLines.push(`[log.${m.params.entry.level}] ${m.params.entry.text}`);
    }
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Network.enable');

  console.error('[harness] Navigasi ke', APP_URL);
  await send('Page.navigate', { url: APP_URL });
  await sleep(2500);

  // Suntik gambar sebagai File ke #inputGallery lalu dispatch 'change'
  const b64 = readFileSync(IMG).toString('base64');
  const inject = `(async () => {
    try {
      const b64 = ${JSON.stringify(b64)};
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const blob = new Blob([arr], { type: 'image/jpeg' });
      const file = new File([blob], 'struk_contoh.jpeg', { type: 'image/jpeg' });
      const dt = new DataTransfer(); dt.items.add(file);
      const input = document.getElementById('inputGallery');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return 'injected:' + file.size;
    } catch (e) { return 'inject-error:' + e.message; }
  })()`;
  const inj = await send('Runtime.evaluate', { expression: inject, awaitPromise: true, returnByValue: true });
  console.error('[harness] Inject:', inj.result && inj.result.value);

  // Poll sampai stage konfirmasi tampil atau timeout
  const start = Date.now();
  let snapshot = null;
  while (Date.now() - start < MAX_WAIT_MS) {
    const expr = `(() => {
      const ov = document.getElementById('captureOverlay');
      const confirmVisible = !document.getElementById('stageConfirm').classList.contains('hidden');
      const processVisible = !document.getElementById('stageProcess').classList.contains('hidden');
      const q = s => { const el = document.querySelector(s); return el ? (el.value !== undefined ? el.value : el.textContent) : null; };
      const items = Array.from(document.querySelectorAll('#confirmFormWrap .item-row')).map(r => ({
        nama: r.querySelectorAll('.input')[0] ? r.querySelectorAll('.input')[0].value : '',
        harga: r.querySelectorAll('.input')[1] ? r.querySelectorAll('.input')[1].value : ''
      }));
      return {
        confirmVisible, processVisible,
        procStatus: q('#procStatus'),
        scanHint: q('#scanHint'),
        ocrNotice: q('#ocrNotice'),
        rawOcr: q('#rawOcr'),
        merchant: q('.f-merchant'),
        tanggal: q('.f-tanggal'),
        total: q('.f-total'),
        kategori: (document.querySelector('#confirmFormWrap .chip.active')||{}).textContent || null,
        items,
        scanPreview: (document.getElementById('scanPreview')||{}).src ? document.getElementById('scanPreview').src.slice(0,30) : null
      };
    })()`;
    let r;
    try { r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); } catch (e) { r = null; }
    if (r && r.result && r.result.value) {
      snapshot = r.result.value;
      if (snapshot.confirmVisible) break;
    }
    await sleep(3000);
  }

  // Simpan preview scan jika ada
  let scanDataUrl = null;
  try {
    const r = await send('Runtime.evaluate', {
      expression: `(document.getElementById('scanPreview')||{}).src || null`,
      returnByValue: true
    });
    scanDataUrl = r.result && r.result.value;
    if (scanDataUrl && scanDataUrl.startsWith('data:image')) {
      const b = scanDataUrl.split(',')[1];
      writeFileSync(join(__dirname, 'scan-preview.jpg'), Buffer.from(b, 'base64'));
    }
    const ro = await send('Runtime.evaluate', { expression: `(document.getElementById('origPreview')||{}).src || null`, returnByValue: true });
    const origUrl = ro.result && ro.result.value;
    if (origUrl && origUrl.startsWith('data:image')) {
      writeFileSync(join(__dirname, 'orig-injected.jpg'), Buffer.from(origUrl.split(',')[1], 'base64'));
    }
  } catch (e) { /* ignore */ }

  writeFileSync(join(__dirname, 'console.txt'), consoleLines.join('\n'), 'utf8');
  writeFileSync(join(__dirname, 'hasil-repro.json'), JSON.stringify({
    appUrl: APP_URL, image: IMG, imageBytes: readFileSync(IMG).length,
    finishedAt: new Date().toISOString(), snapshot, console: consoleLines
  }, null, 2), 'utf8');

  console.log(JSON.stringify({ snapshot, consoleTail: consoleLines.slice(-40) }, null, 2));

  try { ws.close(); } catch {}
  chrome.kill();
  await sleep(500);
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
}

main().catch(e => { console.error('[harness] GAGAL:', e); process.exit(1); });
