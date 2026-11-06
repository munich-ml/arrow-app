import {ArrowDevice} from './transport.js';
import {decode,csv,csvAll,live,ERRORS,crc32,exportable,damageReport} from './protocol.js';
import {parseCsv} from './csv-import.js';
import {sessionLabel,sessionDate,csvFilename,allCsvFilename} from './naming.js';
import {validChannels,NEUTRAL} from './rudders.js';
import {powerText,batteryPercent} from './power.js';
import {BatteryHistory,segments,BUCKET_MS} from './battery-history.js';
import {ticks,label,ZoomView} from './timeaxis.js';
import {bodyAxes,BODY_LABELS} from './mount.js';
const $=id=>document.getElementById(id),device=new ArrowDevice();
let connected=false,latest=null,busy=false,data={sessions:[],errors:[]},livePoints=[],abort;
let boardSessions=null,boardSnapshot=null,switchedOff=false;
let rudderState=null,rudderWorking=false,rudderPending=false;
const sides=['left','right'];
function showRudders(value,fill=false) {
  rudderState=value;
  if(value?.active) $('rudderPanel').open=true; // never hide active outputs
  const label=value?.active?'PWM aktiv · 333 Hz':value||!connected?'PWM aus':'PWM-Status unbekannt';
  if($('rudderStatus').textContent!==label) $('rudderStatus').textContent=label;
  if(value) sides.forEach((side,i)=>{
    const c=value.channels[i];
    $(side+'Pulse').min=c.min;$(side+'Pulse').max=c.max;
    if(fill) {$(side+'Min').value=c.min;$(side+'Max').value=c.max;$(side+'Pulse').value=c.pulse;}
    $(side+'Value').textContent=$(side+'Pulse').value+' µs';
  });
  controls();
}
function rudderValues(draft=false) {
  const channels=sides.map((side,i)=>{
    const current=rudderState?.channels[i];
    const min=draft||!current?Number($(side+'Min').value):current.min;
    const max=draft||!current?Number($(side+'Max').value):current.max;
    const pulse=Math.max(min,Math.min(max,Number($(side+'Pulse').value)));
    return {min,max,pulse};
  });
  if(!validChannels(channels)) throw Error('Endanschläge prüfen: 900–2100 µs und Min < Max.');
  return channels;
}
async function rudderPump() {
  if(document.hidden||!connected||!rudderState?.active||busy||device.busy||rudderWorking) return;
  rudderWorking=true;controls();
  const move=rudderPending;rudderPending=false;
  try {
    const value=await device.setRudders(move?2:3,move?rudderValues():undefined);
    if(!connected) return;
    showRudders(value);
  } catch(e) {
    rudderPending=false;
    // Stop renewing the lease after any unconfirmed operation. A new explicit
    // activation is required; do not silently keep moving after an ACK failure.
    showRudders(null);
    $('rudderMessage').textContent=e.message+' · PWM schaltet ohne App-Signal nach 3 s ab.';
  } finally {rudderWorking=false;controls();}
}
setInterval(rudderPump,500);
document.addEventListener('visibilitychange',()=>{
  if(document.hidden) rudderPending=false; // No lease renewal from hidden tabs.
});
// Battery history in this browser only (per-viewer convenience); storage may be unavailable.
const HISTORY_KEY='arrow.batteryHistory.v1';
let history=new BatteryHistory();
try {history=BatteryHistory.fromJSON(JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]'));} catch {}
function saveHistory() {try {localStorage.setItem(HISTORY_KEY,JSON.stringify(history));} catch {}}
const clock=t=>new Date(t).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
function drawBattery() {
  if(!$('batteryPanel').open) return;
  const canvas=$('batteryPlot'),ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height,s=history.series();
  ctx.clearRect(0,0,w,h);ctx.font='13px system-ui';ctx.fillStyle='#aabac8';
  if(!s.length){ctx.fillText('Noch kein Verlauf – Werte kommen, solange die App mit dem XIAO verbunden ist.',30,40);return;}
  const L=62,R=48,T=12,B=30,x0=s[0].t,x1=Math.max(s.at(-1).t+BUCKET_MS,x0+10*60000);
  const lo=Math.floor(Math.min(3300,...s.map(p=>p.minMv))/100)*100,hi=Math.ceil(Math.max(4300,...s.map(p=>p.mv))/100)*100;
  const X=t=>L+(t-x0)/(x1-x0)*(w-L-R),Y=mv=>T+(hi-mv)/(hi-lo)*(h-T-B);
  for(const p of s) {
    const xa=X(p.t),xb=X(p.t+BUCKET_MS);
    if(p.usb){ctx.fillStyle='rgba(110,231,207,.12)';ctx.fillRect(xa,T,xb-xa,h-T-B);}
    if(p.charging){ctx.fillStyle='#ffb56b';ctx.fillRect(xa,h-B-5,xb-xa,5);}
  }
  const step=hi-lo>1000?200:100;
  for(let v=lo;v<=hi;v+=step) {
    const y=Y(v);ctx.strokeStyle='#293b49';ctx.beginPath();ctx.moveTo(L,y);ctx.lineTo(w-R,y);ctx.stroke();
    ctx.fillStyle='#aabac8';ctx.fillText(`${(v/1000).toFixed(1).replace('.',',')} V`,8,y+4);if(v<=4200)ctx.fillText(`${batteryPercent(v)} %`,w-R+6,y+4);
  }
  // Round clock ticks (local time), at most six.
  const tick=[10,15,30,60,120,240,360].map(m=>m*60000).find(ms=>(x1-x0)/ms<=6)||360*60000,off=new Date(x0).getTimezoneOffset()*60000;
  for(let t=Math.ceil((x0-off)/tick)*tick+off;t<=x1;t+=tick){ctx.strokeStyle='#22313c';ctx.beginPath();ctx.moveTo(X(t),T);ctx.lineTo(X(t),h-B);ctx.stroke();ctx.fillStyle='#aabac8';ctx.fillText(clock(t),Math.max(L,Math.min(w-R-40,X(t)-18)),h-8);}
  ctx.strokeStyle=ctx.fillStyle='#6ee7cf';ctx.lineWidth=2;
  for(const seg of segments(s)) {
    ctx.beginPath();seg.forEach((p,i)=>{const x=X(p.t+BUCKET_MS/2),y=Y(p.mv);if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y);});ctx.stroke();
    if(seg.length===1){ctx.beginPath();ctx.arc(X(seg[0].t+BUCKET_MS/2),Y(seg[0].mv),3,0,7);ctx.fill();}
  }
  ctx.lineWidth=1;
}
$('batteryPanel').addEventListener('toggle',drawBattery);
$('batteryClear').onclick=()=>{history.clear();saveHistory();drawBattery();};
function showPower(p) {
  if(history.add(p)){saveHistory();drawBattery();}
  const t=powerText(p);
  $('battery').textContent=t.battery;$('supply').textContent=t.supply;$('powerInfo').textContent=t.info;
  for(const id of ['battery','powerInfo']) $(id).classList.toggle('warn',t.warn);
}
function renderBoard() {
  $('boardCount').textContent=boardSessions===null?'—':String(boardSessions.length);
  $('boardSessions').replaceChildren(...(boardSessions||[]).map(s=>{
    const row=document.createElement('tr');
    for(const [value,title] of [[`#${s.id}`],[sessionDate(s.epoch)],[`${(s.size/1024).toLocaleString('de-DE',{maximumFractionDigits:2})} KiB`,`${s.size.toLocaleString('de-DE')} Byte`]]) {
      const cell=document.createElement('td');cell.textContent=value;if(title)cell.title=title;row.append(cell);
    }
    return row;
  }));
}
async function refreshBoard() {
  $('boardInfo').textContent='Lese Übersicht…';
  try {
    boardSessions=await device.listSessions();boardSnapshot={used:latest.used,session:latest.session};renderBoard();
    $('boardInfo').textContent=boardSessions.length?'':'Keine Sessions gespeichert.';
  } catch(e) {boardSessions=null;boardSnapshot=null;renderBoard();$('boardInfo').textContent=e.message;}
}
function controls() {
  for(const id of ['connect','demo','file']) $(id).disabled=busy||(id==='connect'&&connected);
  $('disconnect').disabled=!connected;
  $('powerOff').disabled=!connected||busy||!latest?.offAvailable||![0,3].includes(latest?.state)||!!rudderState?.active;
  for(const id of ['start','download','configure','rate']) $(id).disabled=!connected||busy||latest?.state!==0;
  $('stop').disabled=!connected||busy||latest?.state!==1;
  $('erase').disabled=!connected||busy||![0,3].includes(latest?.state);
  $('refreshSessions').disabled=!connected||busy||![0,3].includes(latest?.state)||!latest?.catalogAvailable;
  const canEdit=connected&&!!latest?.ruddersAvailable&&[0,1].includes(latest?.state)&&!busy;
  // Background keepalives must not toggle the visible controls. Foreground
  // actions already wait for rudderWorking before issuing their BLE command.
  const canRudder=canEdit;
  $('rudderEnable').disabled=!canRudder||!!rudderState?.active;
  $('rudderOff').disabled=!connected||!latest?.ruddersAvailable||busy;
  $('rudderLimits').disabled=!canRudder;
  $('rudderNeutral').disabled=!canRudder||!rudderState?.active;
  for(const side of sides) {
    $(side+'Pulse').disabled=!canEdit||!rudderState?.active;
    $(side+'Min').disabled=!canEdit;$(side+'Max').disabled=!canEdit;
  }
  if(rudderState?.active) for(const id of ['download','erase','refreshSessions']) $(id).disabled=true;
  $('allCsv').disabled=!exportable(data.sessions).some(s=>s.samples.length); $('csv').disabled=!selected()?.samples.length||!!selected()?.errors;
}
function update(s) {
  latest=s; $('state').textContent=s.state===3?`Fehler: ${ERRORS[s.error]||'Hardwareinitialisierung'} (${s.error})`:['Bereit','Aufzeichnung','Löschen…','Fehler','Download'][s.state];
  $('memory').textContent=`${(s.used/1024).toFixed(1)} / 2048 KiB`;
  $('samples').textContent=`${s.count} / ${s.dropped}`;
  if(boardSnapshot && (s.used!==boardSnapshot.used||s.session!==boardSnapshot.session)) {
    boardSnapshot=null;boardSessions=null;renderBoard();
    $('boardInfo').textContent='Speicher geändert · nach Stopp aktualisieren.';
  }
  if(s.error) $('message').textContent=ERRORS[s.error]||`Fehler ${s.error}`;
  else if(s.recoveredCorrupt) $('message').textContent='Beschädigte Flash-Records gefunden; betroffene Sessions werden beim Laden markiert.';
  if(showingLive()) describe();
  controls();
}
async function action(fn) {
  if(busy) return; busy=true; $('message').textContent=''; controls();
  try {
    while(rudderWorking) await new Promise(resolve=>setTimeout(resolve,20));
    await fn();
  } catch(e) {$('message').textContent=e.message;} finally {busy=false; controls();}
}
function selected() {return data.sessions[Number($('session').value)];}
const showingLive=()=>$('source').value==='live';
// Plot time t in ms: wall clock when the start time is known (live: browser clock at
// reception, anchored once per IMU start), otherwise seconds since start x 1000.
const zoom=new ZoomView();let paused=null,liveAnchor=0; // paused: frozen copy of livePoints
const PL=65,PR=20,PT=25,PB=40;
function plotData() {
  if(showingLive()) return {points:paused||livePoints,wall:true};
  const s=selected();if(!s) return {points:[],wall:true};
  const wall=s.epoch>0;
  return {points:s.samples.map(p=>({t:(wall?s.epoch:0)+p.us/1000,axes:p.axes})),wall};
}
const fullRange=points=>points.length?[points[0].t,Math.max(points.at(-1).t,points[0].t+1)]:null;
function draw() {
  const canvas=$('plot'),ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height,{points,wall}=plotData();
  const kind=$('kind').value,base=kind==='gyro'?0:3;ctx.clearRect(0,0,w,h);
  BODY_LABELS[kind].forEach((text,i)=>{$('legend').children[i].textContent=text;});
  $('legend').children[3].textContent=wall?'Uhrzeit →':'Zeit [s] →';
  ctx.font='13px system-ui';ctx.fillStyle='#aabac8';zoomControls(points);
  if(!points.length){ctx.fillText('Keine Messdaten',30,40);return;}
  const [a,b]=zoom.range(fullRange(points)),vis=points.filter(p=>p.t>=a&&p.t<=b);
  // Thin only the visible window; plot in model axes, samples keep the raw sensor axes.
  const step=Math.max(1,Math.ceil(vis.length/1500)),p=vis.filter((_,i)=>i%step===0).map(s=>({t:s.t,axes:bodyAxes(s.axes)}));
  let lo=Infinity,hi=-Infinity;
  for(const s of p)for(let i=base;i<base+3;i++){lo=Math.min(lo,s.axes[i]);hi=Math.max(hi,s.axes[i]);}
  if(!p.length){lo=-1;hi=1;}
  if(hi-lo<.01){hi+=.1;lo-=.1;} const pad=(hi-lo)*.08;hi+=pad;lo-=pad;
  const X=t=>PL+(t-a)/(b-a)*(w-PL-PR),Y=v=>PT+(hi-v)/(hi-lo)*(h-PT-PB);
  for(let i=0;i<=4;i++){
    const y=PT+i*(h-PT-PB)/4;ctx.strokeStyle='#293b49';ctx.beginPath();ctx.moveTo(PL,y);ctx.lineTo(w-PR,y);ctx.stroke();
    ctx.fillStyle='#aabac8';ctx.fillText((hi-(hi-lo)*i/4).toFixed(2),8,y+4);
  }
  const axis=ticks(a,b,{wall});
  for(const t of axis.ticks){
    const x=X(t);ctx.strokeStyle='#22313c';ctx.beginPath();ctx.moveTo(x,PT);ctx.lineTo(x,h-PB);ctx.stroke();
    const text=label(t,axis.step,wall);ctx.fillStyle='#aabac8';ctx.fillText(text,Math.max(PL,Math.min(w-PR-ctx.measureText(text).width,x-ctx.measureText(text).width/2)),h-12);
  }
  ['#6ee7cf','#ffb56b','#b6a0ff'].forEach((color,i)=>{
    ctx.strokeStyle=color;ctx.lineWidth=1.7;ctx.beginPath();p.forEach((s,j)=>{
      const x=X(s.t),y=Y(s.axes[base+i]);if(j)ctx.lineTo(x,y);else ctx.moveTo(x,y);
    });ctx.stroke();
  });
  ctx.lineWidth=1;
  if(zoom.win||paused){ctx.fillStyle='#a0b0bf';const note=[paused?'Pausiert':'',zoom.win?'Zoom · Doppelklick zeigt alles':''].filter(Boolean).join(' · ');ctx.fillText(note,w-PR-ctx.measureText(note).width,PT-8);}
}
function zoomControls(points) {
  $('pause').disabled=!showingLive();$('pause').textContent=paused?'▶ Weiter':'⏸ Pause';
  $('zoomIn').disabled=!points.length;$('zoomOut').disabled=$('zoomReset').disabled=!zoom.win;
}
function setPaused(on) {paused=on?livePoints.slice():null;if(!on)zoom.reset();draw();}
function zoomBy(factor,center=0.5) {
  if(showingLive()&&!paused&&factor<1) paused=livePoints.slice(); // zooming into live data pauses it
  const full=fullRange(plotData().points);if(!full)return;
  zoom.zoom(full,factor,center);draw();
}
function resetView() {zoom.reset();paused=null;}
{
  const plot=$('plot'),canvasX=e=>{const r=plot.getBoundingClientRect();return (e.clientX-r.left)*plot.width/r.width;};
  const fraction=x=>Math.min(1,Math.max(0,(x-PL)/(plot.width-PL-PR)));
  plot.addEventListener('wheel',e=>{e.preventDefault();zoomBy(e.deltaY<0?0.8:1.25,fraction(canvasX(e)));},{passive:false});
  let drag=null;
  plot.addEventListener('pointerdown',e=>{if(!zoom.win)return;drag=canvasX(e);plot.setPointerCapture(e.pointerId);});
  plot.addEventListener('pointermove',e=>{
    if(drag===null)return;const full=fullRange(plotData().points);if(!full)return;
    const [a,b]=zoom.range(full),x=canvasX(e);zoom.pan(full,-(x-drag)/(plot.width-PL-PR)*(b-a));drag=x;draw();
  });
  for(const type of ['pointerup','pointercancel']) plot.addEventListener(type,()=>{drag=null;});
  plot.addEventListener('dblclick',()=>{zoom.reset();draw();});
  $('pause').onclick=()=>setPaused(!paused);
  $('zoomIn').onclick=()=>zoomBy(0.5);$('zoomOut').onclick=()=>zoomBy(2);$('zoomReset').onclick=()=>{zoom.reset();draw();};
}
function load(parsed) {
  data=parsed;$('source').value='session';resetView();
  $('session').replaceChildren(...data.sessions.map((s,i)=>new Option(sessionLabel(s),i)));
  describe();controls();
  return damageReport(parsed);
}
function describe() {
  if(showingLive()) {
    const note=!connected?'nicht verbunden':latest?.previewAvailable||latest?.state===1?'ca. 10 Hz · letzte 50 s · nicht gespeichert':'Firmware sendet Live nur beim Aufzeichnen – xiao_sense hochladen';
    $('summary').textContent=`Live · ${note}`;draw();return;
  }
  const s=selected();
  const rate=s?.hz?`${s.rateEstimated?'ca. ':''}${s.hz} Hz`:'Rate unbekannt';
  // Date, sample count and completion are already in the session selector.
  $('summary').textContent=s?`${data.demo?'Demo (synthetisch) · ':''}${rate}${s.errors?` · ${s.errors} beschädigte Records, CSV gesperrt`:''}`:'Keine Daten geladen.';
  draw();
}
function save(blob,name) {const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
function onLive(v) {
  const s=live(v),us=s.seconds*1e6;
  if(livePoints.length&&us<livePoints.at(-1).us)livePoints=[]; // IMU restart resets the time base
  if(!livePoints.length) liveAnchor=Date.now()-us/1000; // wall clock at sensor time 0
  livePoints.push({us,t:liveAnchor+us/1000,axes:s.axes});if(livePoints.length>500)livePoints.shift();
  if(showingLive()&&!paused)draw();
}
// Unexpected link loss (e.g. notebook asleep): try to reconnect to the same device
// without the chooser, with growing pauses for about two minutes.
let manualDisconnect=false,reconnecting=false;
const RETRY_S=[1,2,4,8,15,30,30,30];
async function autoReconnect() {
  if(reconnecting||connected||!device.known||manualDisconnect||switchedOff) return;
  reconnecting=true;
  try {
    for(let i=0;i<RETRY_S.length&&!connected&&!manualDisconnect;i++) {
      $('connection').textContent=`Verbinde neu… (${i+1}/${RETRY_S.length})`;
      await new Promise(r=>setTimeout(r,RETRY_S[i]*1000));
      if(connected||manualDisconnect) break;
      if(busy) continue;
      busy=true;controls();
      try {await device.reconnect();await afterConnect();$('message').textContent='';}
      catch {} finally {busy=false;controls();}
    }
    if(!connected&&!manualDisconnect) {
      $('connection').textContent='Getrennt';
      $('message').textContent='Automatisches Wiederverbinden fehlgeschlagen. Ist der XIAO an (blaue LED blinkt alle 2 s)? Sonst Reset kurz drücken, dann „Verbinden“.';
    }
  } finally {reconnecting=false;}
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)autoReconnect();});
setInterval(()=>{if(connected&&latest?.pingAvailable&&!busy&&!rudderWorking)device.ping();},5000);
function onDisconnected() {
  connected=false;showPower(null);if(showingLive())describe();rudderPending=false;showRudders(null);$('rudderMessage').textContent='';boardSessions=null;boardSnapshot=null;renderBoard();$('memory').textContent='—';$('boardInfo').textContent='';$('connection').textContent=switchedOff?'Ausgeschaltet':'Getrennt';if(switchedOff)$('message').textContent='XIAO ist aus · Einschalten: Reset kurz drücken oder USB anstecken.';
  const unexpected=!switchedOff&&!manualDisconnect;switchedOff=false;controls();
  if(unexpected) autoReconnect();
}
async function afterConnect() {
  connected=true;manualDisconnect=false;$('connection').textContent='Verbunden';
  livePoints=[];resetView();$('source').value='live';describe();
  if(!latest.powerAvailable) $('powerInfo').textContent='Akkuanzeige: Firmware 0.2.3 hochladen.';
  const c=await device.chars.config.readValue();$('rate').value=c.getUint16(0,true);
  if(latest.ruddersAvailable) {showRudders(await device.getRudders(),true);$('rudderMessage').textContent='';}
  else $('rudderMessage').textContent='Rudersteuerung: aktuelle Firmware hochladen.';
  if([0,3].includes(latest.state)&&!rudderState?.active) await refreshBoard();
  else $('boardInfo').textContent='Nach Stopp aktualisieren.';
}
$('connect').onclick=()=>action(async()=>{
  manualDisconnect=false;
  // Known device from this page session: reconnect without the chooser first.
  if(device.known) {try {await device.reconnect();await afterConnect();return;} catch {}}
  await device.connect(update,onLive,onDisconnected,showPower);
  await afterConnect();
});
$('disconnect').onclick=()=>{manualDisconnect=true;device.disconnect();};
$('powerOff').onclick=()=>{
  if(!confirm('XIAO ausschalten? Einschalten danach mit dem Reset-Taster oder durch Anstecken von USB.'))return;
  action(async()=>{switchedOff=true;try {await device.powerOff();}catch(e) {switchedOff=false;throw e;}});
};
$('start').onclick=()=>action(async()=>{livePoints=[];update(await device.start());});
$('stop').onclick=()=>action(async()=>{update(await device.stop());if(!rudderState?.active) await refreshBoard();});
$('refreshSessions').onclick=()=>action(refreshBoard);
$('configure').onclick=()=>action(()=>device.setRate(Number($('rate').value)));
$('download').onclick=()=>action(async()=>{
  abort=new AbortController();$('cancel').disabled=false;
  $('progress').textContent='Vorbereiten…';
  try {
    const bytes=await device.downloadAll((p,info)=>{
      const speed=info?.bytesPerSecond/1024||0;
      $('progress').textContent=`${Math.floor(p*100)} % · ${speed.toFixed(1)} KiB/s`;
    },abort.signal);
    const report=load(decode(bytes));
    await refreshBoard();
    $('progress').textContent=`${data.sessions.length} ${data.sessions.length===1?'Session':'Sessions'} geladen · CSV bereit`;
    $('message').textContent=[data.sessions.length?'':'Keine Aufzeichnungen im Flash.',report].filter(Boolean).join(' ');
  } catch(e) {$('progress').textContent='Laden abgebrochen';throw e;}
  finally {$('cancel').disabled=true;}
});
$('cancel').onclick=()=>abort?.abort();
$('erase').onclick=()=>{if(confirm('Alle Aufzeichnungen im Board unwiderruflich löschen? Zuerst alle Sessions als CSV sichern.'))action(async()=>{update(await device.erase());await refreshBoard();});};
$('allCsv').onclick=()=>{
  const clean=exportable(data.sessions),skipped=data.sessions.length-clean.length;
  save(new Blob([csvAll(clean)],{type:'text/csv;charset=utf-8'}),allCsvFilename());
  if(skipped)$('message').textContent=`${skipped} beschädigte ${skipped===1?'Session':'Sessions'} nicht exportiert.`;
};
$('csv').onclick=()=>save(new Blob([csv(selected())],{type:'text/csv;charset=utf-8'}),csvFilename(selected()));
$('file').onchange=e=>action(async()=>{const f=e.target.files[0];if(f){if(f.size>32*1024*1024)throw Error('CSV größer als 32 MiB');load(parseCsv(await f.text()));}});
$('session').onchange=()=>{$('source').value='session';resetView();describe();};
$('source').onchange=()=>{resetView();describe();};$('kind').onchange=()=>draw();
$('demo').onclick=()=>{
  const bytes=new Uint8Array(32*262),d=new DataView(bytes.buffer);
  for(let i=0;i<262;i++){
    const o=i*32;bytes[o]=i===0?1:i===261?3:2;bytes[o+1]=1;d.setUint32(o+4,1,true);
    if(i===0){d.setBigUint64(o+8,BigInt(Date.now()),true);d.setUint16(o+16,52,true);bytes[o+18]=4;bytes[o+19]=5;d.setUint32(o+20,25,true);}
    else if(i===261){d.setUint32(o+16,260,true);}
    else {d.setBigUint64(o+8,BigInt(Math.round(i*1e6/52/25)*25),true);for(let a=0;a<6;a++)d.setInt16(o+16+a*2,Math.round((a===5?-8197:0)+Math.sin(i/15+a)*1500),true);}
    d.setUint32(o+28,crc32(bytes.subarray(o,o+28)),true);
  }
  const demo=decode(bytes);demo.demo=true;load(demo);
};
for(const side of sides) $(side+'Pulse').oninput=()=>{
  $(side+'Value').textContent=$(side+'Pulse').value+' µs';
  rudderPending=true;setTimeout(rudderPump,80);
};
$('rudderEnable').onclick=()=>action(async()=>{
  showRudders(await device.setRudders(1,rudderValues(true)),true);
  $('rudderMessage').textContent='';
});
$('rudderOff').onclick=()=>action(async()=>{
  rudderPending=false;showRudders(await device.setRudders(0));$('rudderMessage').textContent='';
});
$('rudderLimits').onclick=()=>action(async()=>{
  const values=rudderValues(true);
  if(rudderState?.active) showRudders(await device.setRudders(2,values),true);
  else {showRudders({...rudderState,active:false,channels:values},true);}
  $('rudderMessage').textContent=rudderState?.active?'':'Endanschläge vorgemerkt, gelten ab „PWM an“.';
});
$('rudderNeutral').onclick=()=>action(async()=>{
  const values=rudderValues().map(c=>({...c,pulse:Math.max(c.min,Math.min(c.max,NEUTRAL))}));
  rudderPending=false;showRudders(await device.setRudders(2,values),true);
});
if(!isSecureContext||!navigator.bluetooth)$('hint').textContent='Bluetooth nicht verfügbar: Chrome über localhost (PC) oder HTTPS (Android). Demo und CSV funktionieren.';
draw();controls();
// Offline support and installation (HTTPS or localhost only); the page works without it.
if('serviceWorker' in navigator&&isSecureContext) navigator.serviceWorker.register('sw.js').catch(()=>{});
