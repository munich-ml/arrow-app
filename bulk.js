import {CAPACITY,crc32,view} from './protocol.js';
export const WINDOW_SIZE=4096;
export function windowCommand(token,offset,length) {
  if(!Number.isInteger(token)||token<=0||token>0xffffffff||!Number.isInteger(offset)||offset<0||offset%32||
     !Number.isInteger(length)||length<=0||length>WINDOW_SIZE||length%32||offset+length>CAPACITY) throw Error('Ungültiges Downloadfenster');
  const b=new Uint8Array(11),d=new DataView(b.buffer);b[0]=5;
  d.setUint32(1,token,true);d.setUint32(5,offset,true);d.setUint16(9,length,true);return b;
}
export class WindowReceiver {
  constructor(token,offset,length) {
    windowCommand(token,offset,length);
    this.token=token;this.offset=offset;this.bytes=new Uint8Array(length);
    this.covered=new Uint8Array(length);this.received=0;this.done=false;
  }
  feed(value) {
    const d=view(value);
    if(d.byteLength<8||d.byteLength>244) throw Error('Ungültige BLE-Paketlänge');
    if(d.getUint32(0,true)!==this.token) return false; // delayed packet from previous attempt
    if(this.done) return false;
    const offset=d.getUint32(4,true);
    if(offset===0xffffffff) {
      if(d.byteLength!==20||d.getUint32(8,true)!==this.offset||d.getUint32(12,true)!==this.bytes.length) throw Error('Download-Abschluss passt nicht zum Fenster');
      if(this.received!==this.bytes.length) throw Error('Downloadfenster unvollständig');
      if(crc32(this.bytes)!==d.getUint32(16,true)) throw Error('CRC-Prüfung des Downloadfensters fehlgeschlagen');
      this.done=true;return true;
    }
    const start=offset-this.offset,length=d.byteLength-8;
    if(!length||start<0||start+length>this.bytes.length) throw Error('BLE-Paket außerhalb des Downloadfensters');
    for(let i=0;i<length;i++) {
      const at=start+i,b=d.getUint8(8+i);
      if(this.covered[at]&&this.bytes[at]!==b) throw Error('Widersprüchliche doppelte Download-Daten');
      if(!this.covered[at]) {this.covered[at]=1;this.received++;}
      this.bytes[at]=b;
    }
    return true;
  }
}
