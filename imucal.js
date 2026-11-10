// IMU calibration in sensor axes (docs: XIAO_firmware/docs/PROTOCOL.md, "IMU-Abgleich").
//   a_cal = (a_raw - offset) * scale [g],  g_cal = g_raw - bias [°/s]
// Fixed point as on the XIAO: offset 0.1 mg, scale-1 1e-5, bias 0.001 °/s. Reference:
// XIAO_eval/arrow_eval/dsp/imucal.py; fitAccel is checked against tests/vectors/imucal_fit.csv.
import {bodyAxes} from './mount.js';
export const CAL_SIZE=28, OFFSET_LSB=1e-4, SCALE_LSB=1e-5, BIAS_LSB=1e-3;
const LIMITS={offsetQ:2500,scaleQ:10000,biasQ:25000};
export const POSE_KEYS=['+x','-x','+y','-y','+z','-z'];
export const emptyCal=()=>({accel:false,gyro:false,offsetQ:[0,0,0],scaleQ:[0,0,0],biasQ:[0,0,0],accelTime:0,gyroTime:0});
const q=(v,lsb)=>Math.round(v/lsb)+0;
export function checkCal(c) {
  for(const [key,limit] of Object.entries(LIMITS))
    if(c[key].length!==3||c[key].some(v=>!Number.isInteger(v)||Math.abs(v)>limit)) throw Error('Abgleichwert außerhalb des plausiblen Bereichs');
  if(!c.accel&&(c.offsetQ.some(Boolean)||c.scaleQ.some(Boolean))) throw Error('Accel nicht abgeglichen, Werte müssen 0 sein');
  if(!c.gyro&&c.biasQ.some(Boolean)) throw Error('Gyro nicht abgeglichen, Werte müssen 0 sein');
  return c;
}
// Replace the accel part (offset g, scale) and/or the gyro part (bias °/s) of cal.
export function withAccel(cal,offset,scale,time=Math.floor(Date.now()/1000)) {
  return checkCal({...cal,accel:true,offsetQ:offset.map(v=>q(v,OFFSET_LSB)),scaleQ:scale.map(v=>q(v-1,SCALE_LSB)),accelTime:time});
}
export function withGyro(cal,bias,time=Math.floor(Date.now()/1000)) {
  return checkCal({...cal,gyro:true,biasQ:bias.map(v=>q(v,BIAS_LSB)),gyroTime:time});
}
export const physical=c=>({offset:c.offsetQ.map(v=>v*OFFSET_LSB),scale:c.scaleQ.map(v=>1+v*SCALE_LSB),bias:c.biasQ.map(v=>v*BIAS_LSB)});
export const hasCal=c=>!!(c&&(c.accel||c.gyro));
// Same values (flags and fixed point); times are informative only.
export const sameCal=(a,b)=>{
  const x=a||emptyCal(),y=b||emptyCal();
  return x.accel===y.accel&&x.gyro===y.gyro&&['offsetQ','scaleQ','biasQ'].every(k=>x[k].every((v,i)=>v===y[k][i]));
};
// 28 bytes: u8 version 1, u8 flags, 9 x i16, u32 accel time, u32 gyro time. 20 bytes: block only.
export function encodeCal(c) {
  checkCal(c);
  const b=new Uint8Array(CAL_SIZE),d=new DataView(b.buffer);
  b[0]=1;b[1]=(c.accel?1:0)|(c.gyro?2:0);
  [...c.offsetQ,...c.scaleQ,...c.biasQ].forEach((v,i)=>d.setInt16(2+2*i,v,true));
  d.setUint32(20,c.accelTime>>>0,true);d.setUint32(24,c.gyroTime>>>0,true);
  return b;
}
export function decodeCal(value,offset=0,length=value.byteLength-offset) {
  const d=value instanceof DataView?value:new DataView(value.buffer??value,value.byteOffset??0,value.byteLength);
  if(length!==20&&length!==CAL_SIZE) throw Error('Abgleich: 20 oder 28 Byte');
  const at=i=>d.getUint8(offset+i);
  if(at(0)!==1||(at(1)&~3)) throw Error('Abgleich: Version/Flags');
  const v=Array.from({length:9},(_,i)=>d.getInt16(offset+2+2*i,true));
  const c={accel:!!(at(1)&1),gyro:!!(at(1)&2),offsetQ:v.slice(0,3),scaleQ:v.slice(3,6),biasQ:v.slice(6,9),
    accelTime:length===CAL_SIZE?d.getUint32(offset+20,true):0,gyroTime:length===CAL_SIZE?d.getUint32(offset+24,true):0};
  if(!c.accel) c.accelTime=0;
  if(!c.gyro) c.gyroTime=0;
  return checkCal(c);
}
// axes: gx,gy,gz,ax,ay,az (raw); an uncalibrated part stays unchanged.
export function applyCal(c,axes) {
  if(!hasCal(c)) return axes;
  const {offset,scale,bias}=physical(c);
  return [0,1,2].map(i=>axes[i]-bias[i]).concat([0,1,2].map(i=>(axes[3+i]-offset[i])*scale[i]));
}
// Dominant sensor axis of a still pose, e.g. '+z'; null if no axis has 90 % of |a|.
export function poseKey(a,minShare=0.9) {
  const k=[0,1,2].reduce((best,i)=>Math.abs(a[i])>Math.abs(a[best])?i:best,0);
  if(Math.abs(a[k])<minShare*Math.hypot(...a)) return null;
  return (a[k]>0?'+':'-')+'xyz'[k];
}
// Pose in model terms. Load factor n = -a points down: the body axis with n = +1 is down.
const BODY_POSE={'+0':'Nase unten','-0':'Nase oben','+1':'rechte Seite unten','-1':'linke Seite unten','+2':'Normallage (Servos oben)','-2':'Rückenlage (Servos unten)'};
export function poseLabel(key) {
  const a=[0,0,0];a['xyz'.indexOf(key[1])]=key[0]==='+'?1:-1;
  const n=bodyAxes([0,0,0,...a]).slice(3),k=n.findIndex(v=>v!==0);
  return BODY_POSE[(n[k]>0?'+':'-')+k];
}
// Gaussian elimination with partial pivoting (same order as imucal.py _solve).
function solve(a,b) {
  const n=b.length;a=a.map(r=>r.slice());b=b.slice();
  for(let c=0;c<n;c++) {
    let p=c;for(let r=c+1;r<n;r++) if(Math.abs(a[r][c])>Math.abs(a[p][c])) p=r;
    if(Math.abs(a[p][c])<1e-15) throw Error('Accel-Abgleich: Lagen reichen nicht für eine Lösung');
    [a[c],a[p]]=[a[p],a[c]];[b[c],b[p]]=[b[p],b[c]];
    for(let r=c+1;r<n;r++) {const f=a[r][c]/a[c][c];for(let k=c;k<n;k++) a[r][k]-=f*a[c][k];b[r]-=f*b[c];}
  }
  const x=new Array(n).fill(0);
  for(let r=n-1;r>=0;r--) {let s=b[r];for(let k=r+1;k<n;k++) s-=a[r][k]*x[k];x[r]=s/a[r][r];}
  return x;
}
// Offset and scale so that |(m - offset) * scale| = 1 g for every pose m (Gauss-Newton).
export function fitAccel(poses,iterations=20) {
  const keys=new Set(poses.map(p=>poseKey(p))),missing=POSE_KEYS.filter(k=>!keys.has(k));
  if(missing.length) throw Error('Für den Accel-Abgleich fehlen Lagen: '+missing.join(', '));
  const p=[0,0,0,1,1,1];
  for(let it=0;it<iterations;it++) {
    const jtj=Array.from({length:6},()=>new Array(6).fill(0)),jtr=new Array(6).fill(0);
    for(const m of poses) {
      const d=[0,1,2].map(i=>m[i]-p[i]),v=[0,1,2].map(i=>p[3+i]*d[i]),norm=Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]),r=norm-1;
      const j=[...[0,1,2].map(i=>-p[3+i]*v[i]/norm),...[0,1,2].map(i=>d[i]*v[i]/norm)];
      for(let a=0;a<6;a++) {jtr[a]+=j[a]*r;for(let b=0;b<6;b++) jtj[a][b]+=j[a]*j[b];}
    }
    const step=solve(jtj,jtr);
    for(let i=0;i<6;i++) p[i]-=step[i];
    if(Math.max(...step.map(Math.abs))<1e-12) break;
  }
  const res=poses.map(m=>Math.hypot(...[0,1,2].map(i=>p[3+i]*(m[i]-p[i])))-1);
  return {offset:p.slice(0,3),scale:p.slice(3),rms:Math.sqrt(res.reduce((s,r)=>s+r*r,0)/res.length)};
}
// Still: per-axis standard deviation below the limits (a gyro bias does not matter).
export const STILL={gyroStdDps:0.5,accelStdG:0.01};
const mean=(rows,i)=>rows.reduce((s,r)=>s+r[i],0)/rows.length;
const std=(rows,i)=>{const m=mean(rows,i);return Math.sqrt(rows.reduce((s,r)=>s+(r[i]-m)**2,0)/rows.length);};
export function isStill(samples,limits=STILL) {
  if(samples.length<2) return false;
  return [0,1,2].every(i=>std(samples,i)<limits.gyroStdDps)&&[3,4,5].every(i=>std(samples,i)<limits.accelStdG);
}
export const meanAxes=samples=>[0,1,2,3,4,5].map(i=>mean(samples,i));
// Guided calibration on live samples (about 10 Hz). mode 'gyro': 5 s still in any pose.
// mode 'full': every sensor axis up and down, 3 s still each; gyro bias = mean over the poses.
export class CalWizard {
  constructor(mode,{gyroSamples=50,poseSamples=30,limits=STILL}={}) {
    this.mode=mode;this.need=mode==='gyro'?gyroSamples:poseSamples;this.limits=limits;
    this.window=[];this.poses=new Map();this.done=false;
  }
  // Returns the progress after one raw sample (gx..az).
  push(axes) {
    if(this.done) return this.progress();
    this.window.push(axes);
    if(this.window.length>=3&&!isStill(this.window,this.limits)) this.window=[axes]; // moved: start again
    const key=poseKey(meanAxes(this.window).slice(3));
    if(this.mode==='full'&&(!key||this.poses.has(key))) this.window=[axes]; // pose done or unclear: wait
    if(this.window.length>=this.need) {
      const m=meanAxes(this.window);
      if(this.mode==='gyro') {this.bias=m.slice(0,3);this.done=true;}
      else {this.poses.set(key,m);this.window=[];this.done=this.poses.size===6;}
    }
    return this.progress();
  }
  get key() {return this.window.length?poseKey(meanAxes(this.window).slice(3)):null;}
  progress() {return {fraction:this.done?1:this.window.length/this.need,key:this.key,captured:[...this.poses.keys()],done:this.done};}
  // New calibration: current with the gyro part (gyro mode) or both parts (full) replaced.
  result(current=emptyCal(),time=Math.floor(Date.now()/1000)) {
    if(!this.done) throw Error('Kalibrierung nicht abgeschlossen');
    if(this.mode==='gyro') return withGyro(current,this.bias,time);
    const poses=[...this.poses.values()],fit=fitAccel(poses.map(p=>p.slice(3)));
    const bias=[0,1,2].map(i=>poses.reduce((s,p)=>s+p[i],0)/poses.length);
    return {...withGyro(withAccel(current,fit.offset,fit.scale,time),bias,time),rms:fit.rms};
  }
}
// Unit "down" vector in model axes from raw accel (cal applied): load factor n points down.
export function downVector(cal,axes) {
  const n=bodyAxes(applyCal(cal,axes)).slice(3),len=Math.hypot(...n);
  return len>0.2?n.map(v=>v/len):null;
}
