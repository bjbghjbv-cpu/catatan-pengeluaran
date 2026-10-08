// ============================================================
// sub3-verify.mjs — SUB-AGENT 3: independent verification.
//  - Edge cases for Vision.matchDate + Vision.parseReceiptText
//  - Regression: manual entry -> save -> reload -> persist -> export JSON
//  - Console error/exception capture
// Runs the REAL app from http://localhost:8080 (js/*.js untouched).
// Output: laporan/harness/sub3-verify.json
// ============================================================
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_BIN || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP_URL = process.env.APP_URL || 'http://localhost:8080/';
const PORT = Number(process.env.CDP_PORT || 9337);
const DL_DIR = join(tmpdir(), 'sub3-dl-' + Date.now());

const udd = join(tmpdir(), 'cdp-sub3-' + Date.now());
let ws, msgId = 0; const pending = new Map(); const consoleLines = [];
const errors = [];
const send = (m, p = {}) => new Promise((res, rej) => { const id = ++msgId; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method: m, params: p })); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = async p => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
async function ev(expr, aw = true) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: aw, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page err: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
  return r.result && r.result.value;
}

// ---- Test fixtures (independent from Sub-Agent 2) ----
const MATCH_DATE_TESTS = [
  { name: 'EDC line with time', input: 'DATE/TIME 08 OCT 26 14:51', expect: '2026-10-08' },
  { name: '08 OCT 26', input: '08 OCT 26', expect: '2026-10-08' },
  { name: '08-OCT-26', input: '08-OCT-26', expect: '2026-10-08' },
  { name: '07 Oct 2026', input: '07 Oct 2026', expect: '2026-10-07' },
  { name: '7 Okt 2026', input: '7 Okt 2026', expect: '2026-10-07' },
  { name: 'OCT 08, 2026', input: 'OCT 08, 2026', expect: '2026-10-08' },
  { name: 'numeric 08/10/2026', input: '08/10/2026', expect: '2026-10-08' },
  { name: 'ID full 8 Oktober 2026', input: 'Tanggal: 8 Oktober 2026', expect: '2026-10-08' },
  { name: 'fuzzy OCR 08 UCI 26', input: '08 UCI 26', expect: '2026-10-08' },
  { name: 'NOT a date: signature', input: 'SIGNATURE NOT REQUIRED', expect: null },
  { name: 'NOT a date: batch', input: 'BATCH : 006974', expect: null },
  { name: 'NOT a date: total', input: 'TOTAL Rp.77 000', expect: null },
  { name: 'NOT a date: pan', input: 'PAN#9360001430030041385', expect: null }
];

const PARSE_TESTS = [
  {
    name: 'R1 regular shopping (ID) must NOT be EDC',
    text: ['TOKO SUMBER REJEKI', 'Jl. Merdeka No 12 Bandung', '07 Oct 2026',
      'Indomie Goreng 2x 3.500', 'Air Mineral 1x 4.000',
      'TOTAL Rp 11.000', 'TUNAI 20.000', 'KEMBALI 9.000'].join('\n'),
    expect: { merchantIncludes: 'SUMBER REJEKI', tanggal: '2026-10-07', total: 11000, itemsCount: 2, edc: false }
  },
  {
    name: 'R2 discount/tax/subtotal -> GRAND TOTAL',
    text: ['SUPER INDO', '12 Sep 2026', 'Sabun Mandi 15.000', 'Shampoo 25.000',
      'Subtotal 40.000', 'Diskon 4.000', 'PPN 3.600', 'GRAND TOTAL 39.600'].join('\n'),
    expect: { merchantIncludes: 'SUPER INDO', tanggal: '2026-09-12', total: 39600, itemsCount: 2, edc: false }
  },
  {
    name: 'R3 EDC card slip -> items EMPTY',
    text: ['GOOD FRIENDS-HD', 'PACIFIC GARDEN SQUARE', 'GF NO 09-10 ALAM SUTERA',
      'DATE/TIME 08 OCT 26 14:51', 'MERCH 000885003004138', 'BATCH : 006974',
      'TRACE NO: 011523', 'REF.NO. 62814013722', 'APPR CODE 145156',
      'PAN#9360001430030041385', 'TOTAL Rp.77.000', 'SIGNATURE NOT REQUIRED', 'Cardholder Copy'].join('\n'),
    expect: { merchantIncludes: 'GOOD FRIENDS', tanggal: '2026-10-08', total: 77000, itemsCount: 0, edc: true }
  },
  {
    name: 'R4 long PAN/ref number must not become item/price (non-EDC)',
    text: ['TOKO ABC SEJAHTERA', '10 Oct 2026', 'Kopi Susu 15.000',
      'No Referensi 123456789012', 'Total 15.000'].join('\n'),
    expect: { merchantIncludes: 'TOKO ABC', tanggal: '2026-10-10', total: 15000, itemsCount: 1, edc: false }
  },
  {
    name: 'R5 paid by DEBIT must NOT be auto-EDC',
    text: ['WARUNG KOPI NUSANTARA', '11 Oct 2026', 'Nasi Goreng 25.000',
      'Es Teh 5.000', 'TOTAL 30.000', 'DEBIT'].join('\n'),
    expect: { merchantIncludes: 'WARUNG KOPI', tanggal: '2026-10-11', total: 30000, itemsCount: 2, edc: false }
  },
  {
    name: 'R6 subtotal < total priority check',
    text: ['MINIMARKET MAJU', '09 Oct 2026', 'Snack 10.000', 'Subtotal 10.000',
      'TOTAL 12.500'].join('\n'),
    expect: { merchantIncludes: 'MINIMARKET MAJU', tanggal: '2026-10-09', total: 12500, itemsCount: 1, edc: false }
  }
];

function runParserTestsExpr() {
  return `(function(){
    const md = ${JSON.stringify(MATCH_DATE_TESTS)};
    const pt = ${JSON.stringify(PARSE_TESTS)};
    const edcRe = /(signature\\s+not\\s+required|cardholder\\s*copy|ap+p?r(oval)?\\s*code|\\btrace\\s*(no|nd|nu|:)|batch\\s*[:#]|\\bpan\\b|pan#|\\brrn\\b|merch(ant)?\\s*id|terminal\\s*id)/i;
    const dateRes = md.map(t => { let got=null; try{ got=Vision.matchDate(t.input); }catch(e){ got='ERR:'+e.message; }
      return { name:t.name, input:t.input, expect:t.expect, got, pass: got===t.expect }; });
    const parseRes = pt.map(t => {
      let parsed=null, err=null;
      try { parsed = Vision.parseReceiptText(t.text, []); } catch(e){ err=String(e); }
      const m = parsed ? String(parsed.merchant||'') : '';
      const checks = {
        merchant: m.toUpperCase().includes(t.expect.merchantIncludes.toUpperCase()),
        tanggal: parsed && parsed.tanggal === t.expect.tanggal,
        total: parsed && parsed.total === t.expect.total,
        items: parsed && parsed.items.length === t.expect.itemsCount,
        edc: edcRe.test(t.text) === t.expect.edc
      };
      const pass = !err && Object.values(checks).every(Boolean);
      return { name:t.name, expect:t.expect, got: parsed, checks, err, pass };
    });
    return { dateRes, parseRes };
  })()`;
}

async function main() {
  mkdirSync(__dirname, { recursive: true });
  mkdirSync(DL_DIR, { recursive: true });
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${udd}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage',
    '--window-size=1400,1800', 'about:blank'], { stdio: 'ignore' });
  let v = null; for (let i = 0; i < 60; i++) { try { v = await getJSON('/json/version'); break; } catch { await sleep(500); } }
  if (!v) throw new Error('no CDP');
  let ts = await getJSON('/json/list'); let pg = ts.find(t => t.type === 'page');
  if (!pg) { await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }); ts = await getJSON('/json/list'); pg = ts.find(t => t.type === 'page'); }
  ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      const txt = (m.params.args || []).map(a => a.value !== undefined ? String(a.value) : a.description).join(' ');
      consoleLines.push('[' + m.params.type + '] ' + txt);
      if (m.params.type === 'error') errors.push(txt);
    }
    if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; const t = (d.exception && d.exception.description) || d.text; errors.push(t); consoleLines.push('[exception] ' + t); }
  };
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_DIR }).catch(() => {});
  await send('Page.navigate', { url: APP_URL }); await sleep(2500);

  // bersihkan localStorage agar regresi bersih
  await ev(`(function(){ localStorage.removeItem('catatan-pengeluaran-entries-v1'); return 'cleared'; })()`);
  await send('Page.navigate', { url: APP_URL }); await sleep(2000);

  // ---------- A. Parser / matchDate ----------
  const parser = await ev(runParserTestsExpr());

  // ---------- B. Regression: manual add -> save -> reload -> persist ----------
  const addExpr = `(function(){
    try {
      var before = Store.load().length;
      document.getElementById('btnManualHero').click();
      var form = document.querySelector('#editFormWrap .entry-form');
      if(!form) return {ok:false, step:'no-form'};
      function setVal(sel, val){ var el=form.querySelector(sel); el.value=val; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
      setVal('.f-merchant','TOKO UJI SUBAGENT3');
      setVal('.f-tanggal','2026-09-15');
      var chip = form.querySelector('.chip[data-kat="belanja"]'); if(chip) chip.click();
      setVal('.f-total','25000');
      form.querySelector('button[type="submit"]').click();
      var after = Store.load();
      var e = after.filter(function(x){return x.merchant==='TOKO UJI SUBAGENT3';})[0] || null;
      var rows = Array.from(document.querySelectorAll('#txnList .txn-row')).map(function(r){return {id:r.dataset.id, text:(r.textContent||'').replace(/\\s+/g,' ').trim()};});
      return { ok:true, before:before, count:after.length, entry:e, visibleRows:rows, modalHidden:document.getElementById('editModal').classList.contains('hidden') };
    } catch(err){ return {ok:false, step:'exception', error:String(err)}; }
  })()`;
  const add = await ev(addExpr);

  // reload -> persistence
  await send('Page.navigate', { url: APP_URL }); await sleep(2000);
  const persisted = await ev(`(function(){
    var all = Store.load();
    var e = all.filter(function(x){return x.merchant==='TOKO UJI SUBAGENT3';})[0] || null;
    var rows = Array.from(document.querySelectorAll('#txnList .txn-row')).map(function(r){return (r.textContent||'').replace(/\\s+/g,' ').trim();});
    return { count: all.length, entry: e, visibleRows: rows };
  })()`);

  // export JSON via captured Utils.download + real browser download
  const exportExpr = `(function(){
    try {
      var captured=null;
      var orig = Utils.download;
      Utils.download = function(name, content, type){ captured={name:name,content:content,type:type}; };
      document.getElementById('btnExportJSON').click();
      Utils.download = orig;
      var valid=false, parsed=null, parseErr=null, matched=false;
      try { parsed=JSON.parse(captured.content); valid=Array.isArray(parsed);
        matched = valid && parsed.some(function(x){return x.merchant==='TOKO UJI SUBAGENT3';});
      } catch(e){ parseErr=String(e); }
      return { capturedName: captured && captured.name, capturedType: captured && captured.type,
        contentLen: captured ? captured.content.length : 0, valid, parseErr, matched, parsedCount: parsed?parsed.length:null };
    } catch(err){ return { ok:false, error:String(err) }; }
  })()`;
  const exportCap = await ev(exportExpr);

  // also trigger a real download to disk
  await ev(`document.getElementById('btnExportJSON').click()`);
  await sleep(1500);
  let dlFiles = [];
  try { dlFiles = readdirSync(DL_DIR); } catch {}
  let dlContent = null;
  if (dlFiles.length) {
    const f = join(DL_DIR, dlFiles.find(x => x.endsWith('.json')) || dlFiles[0]);
    if (existsSync(f)) dlContent = (await import('node:fs')).readFileSync(f, 'utf8').slice(0, 400);
  }

  const out = {
    appUrl: APP_URL, at: new Date().toISOString(),
    matchDate: parser.dateRes, parse: parser.parseRes,
    regression: { add, persisted, exportCaptured: exportCap, downloadFiles: dlFiles, downloadPreview: dlContent },
    consoleErrors: errors, console: consoleLines
  };
  writeFileSync(join(__dirname, 'sub3-verify.json'), JSON.stringify(out, null, 2), 'utf8');

  // ---------- Report ----------
  console.log('===== A. matchDate =====');
  for (const r of parser.dateRes) console.log((r.pass ? 'PASS' : 'FAIL') + '  ' + r.name + ' | input=' + JSON.stringify(r.input) + ' expect=' + r.expect + ' got=' + r.got);
  console.log('===== B. parseReceiptText =====');
  for (const r of parser.parseRes) {
    console.log((r.pass ? 'PASS' : 'FAIL') + '  ' + r.name);
    console.log('       got merchant=' + JSON.stringify(r.got && r.got.merchant) + ' tanggal=' + (r.got && r.got.tanggal) + ' total=' + (r.got && r.got.total) + ' items=' + (r.got ? r.got.items.length : '?') + ' checks=' + JSON.stringify(r.checks));
    if (r.err) console.log('       ERR=' + r.err);
  }
  console.log('===== C. regression =====');
  console.log('add:', JSON.stringify(add));
  console.log('persisted after reload:', JSON.stringify(persisted));
  console.log('export captured:', JSON.stringify(exportCap));
  console.log('download files:', JSON.stringify(dlFiles));
  console.log('===== D. console errors =====');
  console.log(errors.length ? errors.join('\n') : '(none)');

  const nFail = parser.dateRes.filter(r => !r.pass).length + parser.parseRes.filter(r => !r.pass).length
    + (add.ok ? 0 : 1) + (exportCap.valid && exportCap.matched ? 0 : 1)
    + ((persisted.entry) ? 0 : 1) + (errors.length ? 1 : 0);
  console.error('[sub3] total FAIL groups:', nFail);

  try { ws.close(); } catch {} chrome.kill(); await sleep(400);
  try { rmSync(udd, { recursive: true, force: true }); } catch {}
  process.exit(0);
}
main().catch(e => { console.error('[sub3] GAGAL:', e); process.exit(1); });
