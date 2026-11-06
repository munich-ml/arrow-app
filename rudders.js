import {view} from './protocol.js';
export const RUDDER_MIN=900,RUDDER_MAX=2100,NEUTRAL=1520;
export function validChannels(channels) {
  return Array.isArray(channels)&&channels.length===2&&channels.every(c=>
    [c.min,c.max,c.pulse].every(Number.isInteger)&&c.min>=900&&c.max<=2100&&c.min<c.max&&c.pulse>=c.min&&c.pulse<=c.max);
}
export function rudderCommand(token,mode,channels) {
  if(!Number.isInteger(token)||token<1||token>0xffffffff||![0,1,2,3].includes(mode)) throw Error('Ungültiger Ruderbefehl');
  const values=mode===1||mode===2;
  if(values&&!validChannels(channels)) throw Error('Ruderwerte: 900–2100 µs, Min < Max, Stellung innerhalb der Endanschläge.');
  const bytes=new Uint8Array(values?18:6),d=new DataView(bytes.buffer);
  bytes[0]=8;d.setUint32(1,token,true);bytes[5]=mode;
  if(values)channels.forEach((c,i)=>[c.min,c.max,c.pulse].forEach((v,j)=>d.setUint16(6+i*6+j*2,v,true)));
  return bytes;
}
export function rudderStatus(value) {
  const d=view(value);
  if(d.byteLength!==20||d.getUint8(0)!==1||d.getUint8(1)>1||d.getUint8(2)>3||d.getUint8(3)>5) throw Error('Unbekanntes Ruderstatusformat');
  const channels=[0,1].map(i=>({min:d.getUint16(8+i*6,true),max:d.getUint16(10+i*6,true),pulse:d.getUint16(12+i*6,true)}));
  if(!validChannels(channels)) throw Error('Ungültige Ruderwerte vom XIAO');
  return {active:!!d.getUint8(1),result:d.getUint8(2),reason:d.getUint8(3),token:d.getUint32(4,true),channels};
}
