// Scrolls steadily while the page records the ship's position once per frame,
// then reports smoothness from evenly-spaced samples.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
const port = await new Promise((r)=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})});
const URL_=process.argv[2];
const profile=mkdtempSync(join(tmpdir(),'rec-'));
const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'--window-size=1440,900','--no-first-run','--ignore-gpu-blocklist','--enable-unsafe-swiftshader','--mute-audio'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ep;for(let i=0;i<80;i++){try{ep=(await(await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;break}catch{await sleep(250)}}
const ws=new WebSocket(ep);await new Promise(r=>ws.onopen=r);
let id=1;const pend=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}};
const send=(me,pa={},si)=>new Promise((res,rej)=>{const i=id++;pend.set(i,{resolve:res,reject:rej});ws.send(JSON.stringify({id:i,method:me,params:pa,sessionId:si}))});
const {targetId}=await send('Target.createTarget',{url:'about:blank'});
const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
const call=(m,p)=>send(m,p,sessionId);
await call('Page.enable');await call('Runtime.enable');
const ev=async(x,aw=false)=>{const{result}=await call('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:aw});return result.value};
await call('Page.navigate',{url:URL_});
for(let i=0;i<400;i++){await sleep(500);try{if(await ev("typeof window.__bg==='object'&&window.__bg!==null"))break}catch{}}
// Scroll from inside the page. Driving it over the debugging protocol meant a
// round trip every 45ms, each one interrupting the renderer — which halved the
// measured frame rate and made the page look far worse than it is.
const rec=ev(`(async()=>{
  const fps=[];
  const scroller=setInterval(()=>window.scrollBy(0,26),45);
  const sampler=setInterval(()=>fps.push(window.__bg.fps()),1000);
  const data=await window.__bg.recordShip(9000);
  clearInterval(scroller); clearInterval(sampler);
  return JSON.stringify({data:JSON.parse(data), fps});
})()`,true);
const parsed=JSON.parse(await rec);
const fpsSamples=parsed.fps;
const {values,times,headings}=parsed.data;
const dt=times.slice(1).map((t,i)=>t-times[i]);
// Velocity and acceleration in time units, not per frame. Frame intervals here
// vary from 16ms to 50ms, so a per-frame difference varies by the same factor
// even when the underlying motion is perfectly smooth — measuring that way makes
// any variable-framerate animation look jerky.
const vel=values.slice(1).map((v,i)=>(v-values[i])/((times[i+1]-times[i])/1000));
const acc=vel.slice(1).map((v,i)=>(v-vel[i])/((times[i+2]-times[i+1])/1000));
const d1=vel, d2=acc;
const peak=a=>Math.max(...a.map(Math.abs));
const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
const crossings=values.slice(1).filter((v,i)=>v*values[i]<0).length;
console.log('fps while scrolling: '+fpsSamples.map(f=>f.toFixed(0)).join(' '));
console.log(`frames ${values.length}  mean interval ${mean(dt).toFixed(1)}ms`);
console.log(`range ${(Math.max(...values)-Math.min(...values)).toFixed(2)}  crossings ${crossings}  saturated ${(values.filter(v=>Math.abs(v)>0.92).length/values.length*100).toFixed(0)}%`);
const sorted=[...acc.map(Math.abs)].sort((a,b)=>a-b);
const p95=sorted[Math.floor(sorted.length*0.95)];
// Does the ship move with the shot, or on its own? Pearson correlation between
// the ship's position and the camera's heading answers it directly.
if (headings && headings.length===values.length){
  const mv=mean(values), mh=mean(headings);
  let num=0,dv=0,dh=0;
  for(let i=0;i<values.length;i++){const a=values[i]-mv,b=headings[i]-mh;num+=a*b;dv+=a*a;dh+=b*b;}
  const r=num/Math.sqrt(dv*dh||1);
  console.log(`correlation with camera heading: ${r.toFixed(3)}  (|r|>0.8 = moves with the shot)`);
}
console.log(`velocity: peak ${peak(vel).toFixed(3)}/s  mean ${mean(vel.map(Math.abs)).toFixed(3)}/s`);
console.log(`acceleration: peak ${peak(acc).toFixed(2)}/s2  p95 ${p95.toFixed(2)}/s2  ratio p95/peak ${(p95/peak(acc)).toFixed(2)}`);
ws.close();chrome.kill();try{rmSync(profile,{recursive:true,force:true})}catch{}
