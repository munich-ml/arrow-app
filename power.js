import {view} from './protocol.js';
export const LOW_MV=3500,DIP_MV=150;
// Rough resting-voltage curve of a 1S LiPo; only an estimate, load and age shift it.
const CURVE=[[3300,0],[3500,3],[3600,8],[3700,22],[3750,35],[3800,45],[3900,62],[4000,78],[4100,90],[4200,100]];
export function power(value) {
  const d=view(value);
  if(d.byteLength!==8) throw Error('Unbekanntes Akkuformat');
  const version=d.getUint8(0),f=d.getUint8(1);
  if(version===0) return {valid:false,usb:false,charging:false,unstable:false}; // no window finished yet
  if(version!==1||f>15) throw Error('Unbekanntes Akkuformat');
  return {valid:!!(f&8),usb:!!(f&1),charging:!!(f&2),unstable:!!(f&4),mv:d.getUint16(2,true),minMv:d.getUint16(4,true),maxMv:d.getUint16(6,true)};
}
export function batteryPercent(mv) {
  if(mv<=CURVE[0][0]) return 0;
  for(let i=1;i<CURVE.length;i++) {
    const [v1,p1]=CURVE[i-1],[v2,p2]=CURVE[i];
    if(mv<=v2) return Math.round(p1+(p2-p1)*(mv-v1)/(v2-v1));
  }
  return 100;
}
const volts=mv=>(mv/1000).toLocaleString('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2});
export function powerText(p) {
  if(!p?.valid) return {battery:p?'Messung läuft…':'—',supply:p?.usb?'USB':'—',info:'',warn:false};
  // On USB the pin shows the charger voltage, not the resting cell voltage.
  const battery=`${volts(p.mv)} V`+(p.usb?'':` · ca. ${batteryPercent(p.mv)} %`);
  const supply=!p.usb?'Akku':p.unstable?'USB · kein Akku erkannt?':p.charging?'USB · lädt':'USB · voll?';
  const notes=[`2 s: ${volts(p.minMv)}–${volts(p.maxMv)} V`];
  const warn=!p.usb&&p.minMv<LOW_MV;
  if(warn) notes.push('Akku schwach – laden');
  if(p.maxMv-p.minMv>=DIP_MV) notes.push(`Spannungseinbruch ${p.maxMv-p.minMv} mV`);
  if(p.unstable) notes.push('Ladeanzeige flackert');
  return {battery,supply,info:notes.join(' · '),warn};
}
