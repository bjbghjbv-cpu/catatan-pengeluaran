// ============================================================
// app-probe.mjs — probe sisi aplikasi (memakai global Vision asli).
// 1. Jalankan pipeline produksi (worker CV + OCR) pada struk.
// 2. Catat quad deteksi, raw OCR, nilai form.
// 3. Jalankan OCR pada FOTO ASLI penuh (setara "mode cepat") via
//    Vision.prepareForOcr + Vision.ocr — sebagai pembanding.
// 4. Jalankan Vision.parseReceiptText pada kedua teks.
// Output: laporan/harness/app-probe.json
// ============================================================
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_BIN || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP_URL = 'http://localhost:8080/';
const IMG = 'C:\\Users\\setia\\Downloads\\struk_contoh.jpeg';
const PORT = Number(process.env.CDP_PORT || 9335);

const userDataDir = join(tmpdir(), 'cdp-probe-' + Date.now());
let ws, msgId = 0; const pending = new Map(); const consoleLines = [];
function send(m, p={}) { return new Promise((res, rej) => { const id=++msgId; pending.set(id,{resolve:res,reject:rej}); ws.send(JSON.stringify({id,method:m,params:p})); }); }
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function getJSON(p){ return (await fetch(`http://127.0.0.1:${PORT}${p}`)).json(); }
async function evalJS(expression, awaitPromise=true){
  const r = await send('Runtime.evaluate',{expression,awaitPromise,returnByValue:true});
  if(r.exceptionDetails) throw new Error('page err: '+JSON.stringify(r.exceptionDetails).slice(0,500));
  return r.result && r.result.value;
}

const CAPTURE = `(() => {
  const q = s => { const el=document.querySelector(s); return el? (el.value!==undefined?el.value:el.textContent):null; };
  const poly = document.querySelector('#quadOverlay polygon');
  const quad = poly ? poly.getAttribute('points') : null;
  const scanImg = document.getElementById('scanPreview');
  let scanW=null, scanH=null, upW=null, upH=null;
  if (scanImg && scanImg.naturalWidth) {
    scanW=scanImg.naturalWidth; scanH=scanImg.naturalHeight;
    const c=document.createElement('canvas'); c.width=scanW; c.height=scanH; c.getContext('2d').drawImage(scanImg,0,0);
    const up=Vision.prepareForOcr(c); upW=up.width; upH=up.height;
  }
  const raw = q('#rawOcr');
  let parsedWarp=null, parseErr=null;
  try { parsedWarp = Vision.parseReceiptText(raw, []); } catch(e){ parseErr=String(e); }
  const items = Array.from(document.querySelectorAll('#confirmFormWrap .item-row')).map(r=>({
    nama:(r.querySelectorAll('.input')[0]||{}).value, harga:(r.querySelectorAll('.input')[1]||{}).value }));
  return { confirmVisible: !document.getElementById('stageConfirm').classList.contains('hidden'),
    scanHint:q('#scanHint'), procStatus:q('#procStatus'), rawOcr:raw,
    quad, scanW, scanH, upW, upH,
    formMerchant:q('.f-merchant'), formTanggal:q('.f-tanggal'), formTotal:q('.f-total'),
    formKategori:(document.querySelector('#confirmFormWrap .chip.active')||{}).textContent||null,
    formItems: items, parsedWarp, parseErr };
})()`;

async function main(){
  mkdirSync(__dirname,{recursive:true});
  const chrome = spawn(CHROME,['--headless=new',`--remote-debugging-port=${PORT}`,`--user-data-dir=${userDataDir}`,
    '--no-first-run','--no-default-browser-check','--disable-gpu','--disable-dev-shm-usage','--window-size=1400,1800','about:blank'],{stdio:'ignore'});
  let ver=null; for(let i=0;i<60;i++){try{ver=await getJSON('/json/version');break;}catch{await sleep(500);}}
  if(!ver) throw new Error('no CDP');
  let targets=await getJSON('/json/list'); let page=targets.find(t=>t.type==='page');
  if(!page){await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`,{method:'PUT'});targets=await getJSON('/json/list');page=targets.find(t=>t.type==='page');}
  ws=new WebSocket(page.webSocketDebuggerUrl); await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
  ws.onmessage=ev=>{const m=JSON.parse(ev.data);
    if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);return;}
    if(m.method==='Runtime.consoleAPICalled'){consoleLines.push((m.params.args||[]).map(a=>a.value!==undefined?String(a.value):a.description).join(' '));}
    if(m.method==='Runtime.exceptionThrown'){const d=m.params.exceptionDetails;consoleLines.push('[exception] '+(d.exception&&d.exception.description||d.text));}};
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  await send('Page.navigate',{url:APP_URL}); await sleep(2500);

  const b64 = readFileSync(IMG).toString('base64');
  const inject = `(async()=>{try{const b64=${JSON.stringify(b64)};const bin=atob(b64);const arr=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);
    const file=new File([new Blob([arr],{type:'image/jpeg'})],'struk_contoh.jpeg',{type:'image/jpeg'});
    window.__FILE=file;
    const dt=new DataTransfer();dt.items.add(file);const input=document.getElementById('inputGallery');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));return 'ok';
  }catch(e){return 'err:'+e.message;}})()`;
  console.error('[probe] inject:', await evalJS(inject));

  // tunggu tahap konfirmasi
  const t0=Date.now(); let cap=null;
  while(Date.now()-t0 < 300000){ cap = await evalJS(CAPTURE); if(cap && cap.confirmVisible) break; await sleep(3000); }
  console.error('[probe] pipeline selesai. scan='+cap.scanW+'x'+cap.scanH+' upscale='+cap.upW+'x'+cap.upH);
  console.log('=== PIPELINE PRODUKSI (warp) ===');
  console.log('quad:', cap.quad); console.log('note:', cap.scanHint);
  console.log('form merchant/tanggal/total/kat:', cap.formMerchant, '|', cap.formTanggal, '|', cap.formTotal, '|', cap.formKategori);
  console.log('form items:', JSON.stringify(cap.formItems));
  console.log('parsedWarp:', JSON.stringify(cap.parsedWarp));
  console.log('rawOcr:', JSON.stringify(cap.rawOcr));

  // Pembanding: OCR FOTO ASLI penuh (setara MODE CEPAT)
  console.error('[probe] OCR foto asli penuh (pembanding)…');
  const fullExpr = `(async()=>{
    const cv = await Vision.fileToCanvas(window.__FILE);
    const dims = { w: cv.width, h: cv.height };
    const fast = Vision.downscale(cv, 1800);
    const prep = Vision.prepareForOcr(fast);
    const prepDims = { w: prep.width, h: prep.height };
    const res = await Vision.ocr(prep, { provider:'none' }, null);
    const parsed = Vision.parseReceiptText(res.text, res.lines || []);
    return { dims, fastDims:{w:fast.width,h:fast.height}, prepDims,
      text: res.text, confidence: res.confidence, nLines: (res.lines||[]).length,
      lines: (res.lines||[]).map(l=>l.text), parsed };
  })()`;
  let full=null;
  try { full = await evalJS(fullExpr); } catch(e){ full={error:String(e.message)}; }
  if(full && !full.error){
    console.log('=== PEMBANDING: OCR FOTO ASLI (mode cepat) ===');
    console.log('dims:', JSON.stringify(full.dims), 'fast:', JSON.stringify(full.fastDims), 'prep:', JSON.stringify(full.prepDims));
    console.log('conf:', Math.round(full.confidence), 'lines:', full.nLines);
    console.log('parsed:', JSON.stringify(full.parsed));
    console.log('text:', JSON.stringify(full.text));
  } else { console.error('pembanding gagal:', full); }

  writeFileSync(join(__dirname,'app-probe.json'),JSON.stringify({image:IMG,cap,full,console:consoleLines},null,2),'utf8');
  console.error('[probe] tersimpan app-probe.json');
  try{ws.close();}catch{} chrome.kill(); await sleep(400);
  try{rmSync(userDataDir,{recursive:true,force:true});}catch{}
}
main().catch(e=>{console.error('[probe] GAGAL:',e);process.exit(1);});
