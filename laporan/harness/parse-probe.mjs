// parse-probe.mjs — menguji Vision.parseReceiptText + matchDate tanpa OCR.
// Membandingkan: teks ideal (ground truth) vs teks OCR nyata (warp & foto asli).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const CHROME='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT=9336;
const udd=join(tmpdir(),'cdp-parse-'+Date.now());
let ws,id=0; const pend=new Map();
const send=(m,p={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{resolve:res,reject:rej});ws.send(JSON.stringify({id:i,method:m,params:p}));});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const getJSON=async p=>(await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
const ev=async(e,aw=true)=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:aw,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails).slice(0,300));return r.result&&r.result.value;};

const IDEAL = [
  'BCA','GOOD FRIENDS-HD','PACIFIC GARDEN SQUARE','GF NO 09-10 ALAM SUTERA',
  'TERM A2FB9600','MERCH 000885003004138','0821****85','SUN BERNAT SETIAWAN','Issuer: BCA',
  'DATE/TIME 08 OCT 26 14:51','PAYMENT DR','DEBIT','BATCH : 006974','TRACE NO: 011523',
  'REF.NO. 62814013722','APPR CODE 145156','RRN QRIS 387270703','TOTAL Rp.77.000',
  '*** SIGNATURE NOT REQUIRED ***','**Cardholder Copy**','ANS042IB','PAN#9360001430030041385'
].join('\n');

const FAST = readFileSync(join(__dirname,'app-probe.json'),'utf8');
const fastObj = JSON.parse(FAST);
const WARP = fastObj.cap.rawOcr;
const FASTTXT = fastObj.full.text;

const TESTS = [
  { name:'ideal-groundtruth', text: IDEAL },
  { name:'fast-mode-real', text: FASTTXT },
  { name:'warp-real', text: WARP }
];

async function main(){
  mkdirSync(__dirname,{recursive:true});
  const ch=spawn(CHROME,['--headless=new',`--remote-debugging-port=${PORT}`,`--user-data-dir=${udd}`,'--no-first-run','--disable-gpu','--disable-dev-shm-usage','about:blank'],{stdio:'ignore'});
  let v=null;for(let i=0;i<60;i++){try{v=await getJSON('/json/version');break;}catch{await sleep(400);}}
  let ts=await getJSON('/json/list');let pg=ts.find(t=>t.type==='page');
  if(!pg){await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`,{method:'PUT'});ts=await getJSON('/json/list');pg=ts.find(t=>t.type==='page');}
  ws=new WebSocket(pg.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}};
  await send('Runtime.enable');await send('Page.enable');
  await send('Page.navigate',{url:'http://localhost:8080/'});await sleep(2500);
  const out=[];
  for(const t of TESTS){
    const r=await ev(`(function(){ const parsed=Vision.parseReceiptText(${JSON.stringify(t.text)}, []); return {parsed, date: Vision.matchDate("DATE/TIME 08 OCT 26 14:51")}; })()`);
    out.push({name:t.name, parsed:r.parsed, dateCheck:r.date});
    console.log('=== '+t.name+' ===');
    console.log('date(matchDate 08 OCT 26) =', r.date);
    console.log('merchant =', JSON.stringify(r.parsed.merchant));
    console.log('tanggal  =', r.parsed.tanggal);
    console.log('total    =', r.parsed.total);
    console.log('items    =', r.parsed.items.length, JSON.stringify(r.parsed.items));
  }
  writeFileSync(join(__dirname,'parse-probe.json'),JSON.stringify(out,null,2),'utf8');
  try{ws.close();}catch{}ch.kill();await sleep(300);try{rmSync(udd,{recursive:true,force:true});}catch{}
}
main().catch(e=>{console.error('GAGAL',e);process.exit(1);});
