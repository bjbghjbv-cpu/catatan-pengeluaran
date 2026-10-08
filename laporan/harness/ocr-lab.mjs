// ============================================================
// ocr-lab.mjs — menguji Tesseract.js pada beberapa varian gambar
// (scan hasil warp app vs foto asli) dan beberapa konfigurasi.
// Menjawab: apakah masalahnya rotasi/warp, preprocessing, atau PSM?
// Output: laporan/harness/ocr-lab.json
// ============================================================
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_BIN || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9334);
const SRC = 'C:\\Users\\setia\\Downloads\\struk_contoh.jpeg';
const SCAN = join(__dirname, 'scan-preview.jpg');

const userDataDir = join(tmpdir(), 'cdp-ocr-' + Date.now());
let ws, msgId = 0;
const pending = new Map();
const logs = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(path) { return (await fetch(`http://127.0.0.1:${PORT}${path}`)).json(); }

async function evalJS(expression, awaitPromise = true) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page error: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result && r.result.value;
}

const CONFIGS = [
  { id: 'scan_rot0_psm3', img: 'scan', rot: 0, pre: 'none', psm: '3' },
  { id: 'scan_rot0_psm6', img: 'scan', rot: 0, pre: 'none', psm: '6' },
  { id: 'scan_rot90_psm6', img: 'scan', rot: 90, pre: 'none', psm: '6' },
  { id: 'scan_rot270_psm6', img: 'scan', rot: 270, pre: 'none', psm: '6' },
  { id: 'scan_rot270_psm3', img: 'scan', rot: 270, pre: 'none', psm: '3' },
  { id: 'orig_rot0_psm3', img: 'orig', rot: 0, pre: 'none', psm: '3' },
  { id: 'orig_rot0_psm6', img: 'orig', rot: 0, pre: 'none', psm: '6' },
  { id: 'orig_rot0_psm4', img: 'orig', rot: 0, pre: 'none', psm: '4' },
  { id: 'orig_gray2x_psm6', img: 'orig', rot: 0, pre: 'gray2x', psm: '6' },
  { id: 'orig_otsu_psm3', img: 'orig', rot: 0, pre: 'otsu', psm: '3' },
  { id: 'orig_otsu_psm6', img: 'orig', rot: 0, pre: 'otsu', psm: '6' },
  { id: 'orig_adaptive_psm6', img: 'orig', rot: 0, pre: 'adaptive', psm: '6' }
];

const PAGE_HELPERS = `
window.__ready = (async () => {
  window.__T = await new Promise((res, rej) => {
    if (window.Tesseract) return res(window.Tesseract);
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    s.onload = () => res(window.Tesseract); s.onerror = () => rej(new Error('load tesseract gagal'));
    document.head.appendChild(s);
  });
  window.__imgs = {};
  const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  window.__imgs.orig = await loadImg(window.__ORIG);
  window.__imgs.scan = await loadImg(window.__SCAN);
  window.__worker = await window.__T.createWorker('ind+eng', 1, {
    logger: m => { if (m && m.status === 'recognizing text' && Math.random() < 0.02) console.log('[tess] ' + m.progress); },
    errorHandler: e => console.log('[tess-err] ' + e)
  });
  return 'ready';
})();
window.__render = function(imgKey, rot, pre) {
  const img = window.__imgs[imgKey];
  let w = img.naturalWidth, h = img.naturalHeight;
  if (rot === 90 || rot === 270) { const t = w; w = h; h = t; }
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.save();
  if (rot === 90) { ctx.translate(w, 0); ctx.rotate(Math.PI/2); }
  else if (rot === 180) { ctx.translate(w, h); ctx.rotate(Math.PI); }
  else if (rot === 270) { ctx.translate(0, h); ctx.rotate(-Math.PI/2); }
  ctx.drawImage(img, 0, 0);
  ctx.restore();
  if (pre === 'none') return c;
  if (pre === 'gray2x') {
    const c2 = document.createElement('canvas'); c2.width = w*2; c2.height = h*2;
    const x2 = c2.getContext('2d'); x2.imageSmoothingQuality = 'high'; x2.drawImage(c, 0, 0, w*2, h*2);
    const d = x2.getImageData(0,0,c2.width,c2.height); const p = d.data;
    for (let i=0;i<p.length;i+=4){ const g=(0.299*p[i]+0.587*p[i+1]+0.114*p[i+2]); p[i]=p[i+1]=p[i+2]=g; }
    x2.putImageData(d,0,0); return c2;
  }
  // grayscale first
  const d = ctx.getImageData(0,0,w,h); const p = d.data;
  const gray = new Uint8ClampedArray(w*h);
  for (let i=0,j=0;i<p.length;i+=4,j++){ gray[j]=0.299*p[i]+0.587*p[i+1]+0.114*p[i+2]; }
  let out = ctx.createImageData(w,h); const o = out.data;
  if (pre === 'otsu') {
    const hist = new Array(256).fill(0); for (let j=0;j<gray.length;j++) hist[gray[j]|0]++;
    const total = gray.length; let sum=0; for (let t=0;t<256;t++) sum+=t*hist[t];
    let sumB=0,wB=0,maxVar=0,thr=127;
    for (let t=0;t<256;t++){ wB+=hist[t]; if(!wB) continue; const wF=total-wB; if(!wF) break; sumB+=t*hist[t];
      const mB=sumB/wB, mF=(sum-sumB)/wF, between=wB*wF*(mB-mF)*(mB-mF); if(between>maxVar){maxVar=between;thr=t;} }
    for (let j=0;j<gray.length;j++){ const v=gray[j]>thr?255:0; o[j*4]=o[j*4+1]=o[j*4+2]=v; o[j*4+3]=255; }
  } else if (pre === 'adaptive') {
    const R = 15, T = 10; // mean adaptive
    // integral image
    const integ = new Float64Array((w+1)*(h+1));
    for (let y=0;y<h;y++){ let rs=0; for(let x=0;x<w;x++){ rs+=gray[y*w+x]; integ[(y+1)*(w+1)+(x+1)]=integ[y*(w+1)+(x+1)]+rs; } }
    for (let y=0;y<h;y++){ for(let x=0;x<w;x++){
      const x0=Math.max(0,x-R),y0=Math.max(0,y-R),x1=Math.min(w-1,x+R),y1=Math.min(h-1,y+R);
      const area=(x1-x0+1)*(y1-y0+1);
      const s=integ[(y1+1)*(w+1)+(x1+1)]-integ[y0*(w+1)+(x1+1)]-integ[(y1+1)*(w+1)+x0]+integ[y0*(w+1)+x0];
      const v = gray[y*w+x] > (s/area - T) ? 255 : 0;
      o[(y*w+x)*4]=o[(y*w+x)*4+1]=o[(y*w+x)*4+2]=v; o[(y*w+x)*4+3]=255;
    }}
  }
  const c2 = document.createElement('canvas'); c2.width=w; c2.height=h; c2.getContext('2d').putImageData(out,0,0); return c2;
};
window.__runOne = async function(cfg) {
  await window.__ready;
  const c = window.__render(cfg.img, cfg.rot, cfg.pre);
  await window.__worker.setParameters({ tessedit_pageseg_mode: cfg.psm, preserve_interword_spaces: '1', user_defined_dpi: '300' });
  const t0 = performance.now();
  const { data } = await window.__worker.recognize(c);
  const ms = Math.round(performance.now() - t0);
  const tokens = ['GOOD','FRIENDS','PACIFIC','GARDEN','SQUARE','SUTERA','BCA','OCT','77','77.000','000885','14:51','TOTAL','PAYMENT'];
  const hits = {}; tokens.forEach(k => { hits[k] = (data.text.match(new RegExp(k.replace(/[.*+?^\${}()|[\]\\]/g,'\\\\$&'),'gi'))||[]).length; });
  return { text: data.text, confidence: data.confidence, ms, w: c.width, h: c.height, hits };
};
`;

async function main() {
  mkdirSync(__dirname, { recursive: true });
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`,
    '--no-first-run','--no-default-browser-check','--disable-gpu','--disable-dev-shm-usage','about:blank'], { stdio: 'ignore' });
  let ver=null; for (let i=0;i<60;i++){ try{ver=await getJSON('/json/version');break;}catch{await sleep(500);} }
  if(!ver) throw new Error('Chrome CDP tidak merespons');
  let targets = await getJSON('/json/list'); let page = targets.find(t=>t.type==='page');
  if(!page){ await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`,{method:'PUT'}); targets=await getJSON('/json/list'); page=targets.find(t=>t.type==='page'); }
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
  ws.onmessage = ev => { const m=JSON.parse(ev.data);
    if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);return;}
    if(m.method==='Runtime.consoleAPICalled'){ logs.push((m.params.args||[]).map(a=>a.value!==undefined?String(a.value):a.description).join(' ')); }
    if(m.method==='Runtime.exceptionThrown'){ const d=m.params.exceptionDetails; logs.push('[exception] '+(d.exception&&d.exception.description||d.text)); }
  };
  await send('Runtime.enable'); await send('Page.enable');

  const origB64 = readFileSync(SRC).toString('base64');
  const scanB64 = readFileSync(SCAN).toString('base64');
  await evalJS(`window.__ORIG=${JSON.stringify('data:image/jpeg;base64,'+origB64)}; window.__SCAN=${JSON.stringify('data:image/png;base64,'+scanB64)}; 'set'`, false);
  await evalJS(PAGE_HELPERS, false);
  console.error('[lab] inisialisasi Tesseract + gambar…');
  const st = await evalJS('window.__ready', true);
  console.error('[lab] status:', st);

  const results = [];
  for (const cfg of CONFIGS) {
    try {
      console.error('[lab] menjalankan', cfg.id, '…');
      const r = await evalJS(`window.__runOne(${JSON.stringify(cfg)})`, true);
      results.push({ cfg, ...r });
      console.error('   conf=' + Math.round(r.confidence) + ' ms=' + r.ms + ' text="' + (r.text||'').replace(/\s+/g,' ').slice(0,80) + '"');
    } catch (e) {
      results.push({ cfg, error: String(e && e.message || e) });
      console.error('   GAGAL', e.message);
    }
  }

  writeFileSync(join(__dirname, 'ocr-lab.json'), JSON.stringify({ source: SRC, scan: SCAN, results, logs }, null, 2), 'utf8');
  console.log(JSON.stringify(results.map(r => ({ id: r.cfg.id, conf: r.confidence!=null?Math.round(r.confidence):null, ms: r.ms, hits: r.hits, text: (r.text||'').replace(/\s+/g,' ').slice(0,180) })), null, 2));
  try{ws.close();}catch{} chrome.kill(); await sleep(400);
  try{rmSync(userDataDir,{recursive:true,force:true});}catch{}
}
main().catch(e=>{console.error('[lab] GAGAL:', e); process.exit(1);});
