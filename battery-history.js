// Battery history for the overview plot: one-minute means of the 2 s power packets,
// kept for 24 h. Only recorded while the app is connected; the XIAO stores no history.
export const BUCKET_MS=60000,KEEP_MS=24*3600*1000;
export class BatteryHistory {
  constructor(buckets=[]) {this.buckets=buckets;} // {t,sum,n,min,usb,charging}; usb/charging count packets
  add(p,now=Date.now()) {
    if(!p?.valid) return false;
    const t=Math.floor(now/BUCKET_MS)*BUCKET_MS;
    let b=this.buckets.at(-1);
    if(!b||b.t!==t) {b={t,sum:0,n:0,min:p.minMv,usb:0,charging:0};this.buckets.push(b);}
    b.sum+=p.mv;b.n++;b.min=Math.min(b.min,p.minMv);b.usb+=p.usb?1:0;b.charging+=p.charging?1:0;
    while(this.buckets.length&&this.buckets[0].t<t-KEEP_MS) this.buckets.shift();
    return true;
  }
  // Mean per minute; USB/charging by majority of the packets in that minute.
  series() {
    return this.buckets.map(b=>({t:b.t,mv:Math.round(b.sum/b.n),minMv:b.min,usb:b.usb*2>=b.n,charging:b.charging*2>=b.n}));
  }
  clear() {this.buckets=[];}
  toJSON() {return this.buckets;}
  static fromJSON(value,now=Date.now()) {
    const valid=Array.isArray(value)?value.filter(b=>b&&[b.t,b.sum,b.n,b.min,b.usb,b.charging].every(Number.isFinite)&&b.n>0&&b.t>=now-KEEP_MS&&b.t<=now):[];
    return new BatteryHistory(valid.sort((a,b)=>a.t-b.t));
  }
}
// Line segments break at gaps longer than two minutes (app not connected).
export function segments(series,maxGap=2*BUCKET_MS) {
  const out=[];
  for(const p of series) {
    const last=out.at(-1)?.at(-1);
    if(!last||p.t-last.t>maxGap) out.push([p]); else out.at(-1).push(p);
  }
  return out;
}
