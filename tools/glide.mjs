// Captures while the page is actually being scrolled — the ship's glide only
// exists during a turn, so a settled screenshot can never show it.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
const freePort = await new Promise((r)=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})});
const URL_=process.argv[2], OUT=process.argv[3];
mkdirSync(OUT,{recursive:true});
const profile=mkdtempSync(join(tmpdir(),'glide-'));
const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new',`--remote-debugging-port=${freePort}`,`--user-data-dir=${profile}`,'--window-size=1440,900','--no-first-run','--ignore-gpu-blocklist','--enable-unsafe-swiftshader','--mute-audio'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ep;for(let i=0;i<80;i++){try{ep=(await(await fetch(`http://127.0.0.1:${freePort}/json/version`)).json()).webSocketDebuggerUrl;break}catch{await sleep(250)}}
const ws=new WebSocket(ep);await new Promise(r=>ws.onopen=r);
let id=1;const pend=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}};
const send=(me,pa={},si)=>new Promise((res,rej)=>{const i=id++;pend.set(i,{resolve:res,reject:rej});ws.send(JSON.stringify({id:i,method:me,params:pa,sessionId:si}))});
const {targetId}=await send('Target.createTarget',{url:'about:blank'});
const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
const call=(m,p)=>send(m,p,sessionId);
await call('Page.enable');await call('Runtime.enable');
const ev=async x=>{const{result}=await call('Runtime.evaluate',{expression:x,returnByValue:true});return result.value};
await call('Page.navigate',{url:URL_});
for(let i=0;i<400;i++){await sleep(500);try{if(await ev("typeof window.__bg==='object'&&window.__bg!==null"))break}catch{}}
console.log('ready');
const samples=[];
let shot=0;
for(let step=0;step<200;step++){
  await ev(`window.scrollBy(0, 42)`);
  await sleep(40);
  const s=await ev(`JSON.stringify({p:window.__bg.progress(),x:window.__bg.shipOffset?window.__bg.shipOffset():null})`);
  samples.push(JSON.parse(s));
  if(step%40===39){const img=await call('Page.captureScreenshot',{format:'png'});writeFileSync(join(OUT,`glide-${shot++}.png`),Buffer.from(img.data,'base64'));}
}
const xs=samples.map(s=>s.x).filter(v=>v!==null&&Number.isFinite(v));
if(xs.length){
  const min=Math.min(...xs),max=Math.max(...xs);
  const crossings=xs.slice(1).filter((v,i)=>v*xs[i]<0).length;
  const d1=xs.slice(1).map((v,i)=>v-xs[i]);
  const d2=d1.slice(1).map((v,i)=>v-d1[i]);
  const peak=a=>Math.max(...a.map(Math.abs));
  // Saturation is the "always the same movement" tell: pinned at an extreme it
  // has no nuance left, it can only be fully left or fully right.
  const saturated=xs.filter(v=>Math.abs(v)>0.92).length/xs.length;
  const distinct=new Set(xs.map(v=>Math.round(v*10))).size;
  console.log(`range ${(max-min).toFixed(2)} (min ${min.toFixed(2)} max ${max.toFixed(2)})  crossings ${crossings}`);
  console.log(`saturated ${(saturated*100).toFixed(0)}%   distinct positions ${distinct}/21   maxRate ${peak(d1).toFixed(3)}  maxJerk ${peak(d2).toFixed(4)}`);
} else console.log('no ship offset probe');
ws.close();chrome.kill();try{rmSync(profile,{recursive:true,force:true})}catch{}
