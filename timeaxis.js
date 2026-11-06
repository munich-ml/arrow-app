// Time axis and zoom for the analysis plot. Times are milliseconds: wall clock
// (Unix ms) when the start time is known, otherwise seconds since start x 1000.
const STEPS=[100,200,500,1e3,2e3,5e3,1e4,15e3,3e4,6e4,12e4,3e5,6e5,9e5,18e5,36e5,72e5,144e5,216e5];
// Round ticks aligned to local time, at most maxTicks.
export function ticks(t0,t1,{wall=true,maxTicks=6}={}) {
  const step=STEPS.find(s=>(t1-t0)/s<=maxTicks)||STEPS.at(-1);
  const off=wall?new Date(t0).getTimezoneOffset()*60000:0,out=[];
  for(let t=Math.ceil((t0-off)/step)*step+off;t<=t1;t+=step) out.push(t);
  return {step,ticks:out};
}
export function label(t,step,wall=true) {
  if(!wall) return `${(t/1000).toFixed(step<1000?1:0)} s`;
  const d=new Date(t),two=n=>String(n).padStart(2,'0');
  const hm=`${two(d.getHours())}:${two(d.getMinutes())}`;
  if(step>=6e4) return hm;
  return `${hm}:${two(d.getSeconds())}${step<1000?','+Math.floor(d.getMilliseconds()/100):''}`;
}
// Visible window inside the full data range; null window = everything.
export const MIN_SPAN=200;
export class ZoomView {
  constructor() {this.win=null;}
  range(full) {
    if(!this.win) return full;
    const [a,b]=full,span=Math.min(this.win[1]-this.win[0],b-a);
    const lo=Math.min(Math.max(this.win[0],a),b-span);
    return [lo,lo+span];
  }
  // factor < 1 zooms in, > 1 out; center as fraction 0..1 of the current window.
  zoom(full,factor,center=0.5) {
    const [a,b]=this.range(full),span=Math.max(MIN_SPAN,(b-a)*factor),c=a+(b-a)*center;
    if(span>=full[1]-full[0]) {this.win=null;return;}
    this.win=[c-span*center,c-span*center+span];this.win=this.range(full);
  }
  pan(full,deltaMs) {
    if(!this.win) return;
    this.win=[this.win[0]+deltaMs,this.win[1]+deltaMs];this.win=this.range(full);
  }
  reset() {this.win=null;}
}
