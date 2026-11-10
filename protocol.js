import {boardHex} from './boards.js';
import {bodyAxes,BODY_COLUMNS} from './mount.js';
import {decodeCal} from './imucal.js';
export const UUID = Object.fromEntries(['service','control','status','live','download','config','bulk','rudders','power','cal'].map((n,i)=>[n,`b7a1000${i}-6a42-4d87-9c21-82d047b0f001`]));
export const RECORD_SIZE=32, CAPACITY=2097152;
export const ERRORS=['OK','Ungültiges Kommando','Gerät beschäftigt / Zustand unzulässig','IMU-Fehler','Flash-Fehler','Flash voll','Kommando-Warteschlange voll','BLE-Start fehlgeschlagen'];
export function crc32(bytes) {
  let c=0xffffffff;
  for(const b of bytes) { c^=b; for(let j=0;j<8;j++) c=(c>>>1)^((c&1)?0xedb88320:0); }
  return (c^0xffffffff)>>>0;
}
export function view(value) {
  if(value instanceof DataView) return value;
  if(value instanceof ArrayBuffer) return new DataView(value);
  return new DataView(value.buffer,value.byteOffset,value.byteLength);
}
export function status(value) {
  const d=view(value); if(d.byteLength!==20||![1,2].includes(d.getUint8(0))) throw Error('Unbekanntes Statusformat');
  const s={version:d.getUint8(0),state:d.getUint8(1),error:d.getUint8(2),recoveredCorrupt:!!(d.getUint8(3)&1),bulkAvailable:!!(d.getUint8(3)&2),catalogAvailable:!!(d.getUint8(3)&4),ruddersAvailable:!!(d.getUint8(3)&8),previewAvailable:!!(d.getUint8(3)&16),powerAvailable:!!(d.getUint8(3)&32),offAvailable:!!(d.getUint8(3)&64),pingAvailable:!!(d.getUint8(3)&128),used:d.getUint32(4,true),session:d.getUint32(8,true),count:d.getUint32(12,true),dropped:d.getUint32(16,true)};
  if(s.state>4||(s.version===1&&s.state>3)||s.used>CAPACITY||s.used%32) throw Error('Ungültiger Status'); return s;
}
export function startCommand(epoch=Date.now()) {
  const b=new Uint8Array(9); b[0]=1; new DataView(b.buffer).setBigUint64(1,BigInt(epoch),true); return b;
}
export const PING=Uint8Array.of(10); // contact only, keeps the firmware's 90 s app lease
export const powerOffCommand=()=>Uint8Array.of(9,0x4f,0x46,0x46,0x21); // "OFF!"
export function readCommand(offset) {
  if(!Number.isInteger(offset)||offset<0||offset>=CAPACITY||offset%16) throw Error('Ungültiger Offset');
  const b=new Uint8Array(5); b[0]=4; new DataView(b.buffer).setUint32(1,offset,true); return b;
}
// IMU ranges as stored in header bytes 18 (g) and 19 (dps/100) -> datasheet LSB sensitivity.
// Firmware up to 0.2.4: ±4 g / ±500 dps; from 0.2.5: ±16 g / ±2000 dps.
export const ACCEL_LSB_G={4:0.000122,16:0.000488}, GYRO_LSB_DPS={5:0.0175,20:0.070};
export const LEGACY_RANGES={accelG:4,gyroDps100:5};
export function ranges(accelG,gyroDps100) {
  if(!(accelG in ACCEL_LSB_G)||!(gyroDps100 in GYRO_LSB_DPS)) throw Error('Unbekannter Messbereich');
  return {accelG,gyroDps100};
}
// Config readback: u16 rate, from 0.2.5 also accel range (g) and gyro range /100,
// from 0.2.9 the board ID (u32, lower half of the nRF52 DEVICEID).
export function config(value) {
  const d=view(value); if(d.byteLength<2) throw Error('Config-Länge');
  return {hz:d.getUint16(0,true),...(d.byteLength>=4?ranges(d.getUint8(2),d.getUint8(3)):LEGACY_RANGES),
    board:d.byteLength>=8?boardHex(d.getUint32(4,true)):null};
}
export function axes(d,offset,r=LEGACY_RANGES) {
  const g=GYRO_LSB_DPS[r.gyroDps100],a=ACCEL_LSB_G[r.accelG];
  return Array.from({length:6},(_,i)=>d.getInt16(offset+2*i,true)*(i<3?g:a));
}
export function live(value,r=LEGACY_RANGES) {
  const d=view(value); if(d.byteLength!==20) throw Error('Live-Länge');
  return {seconds:d.getUint32(0,true)*25/1e6,axes:axes(d,4,r),sequence:d.getUint32(16,true)};
}
export function decode(value) {
  const d=view(value); if(d.byteLength>CAPACITY||d.byteLength%32) throw Error('Binärdatei muss aus 32-Byte-Records bestehen');
  const sessions=[], errors=[]; let current=null,owner=null;
  // Each error belongs to the last session header before it (owner), or to none.
  // A damaged session is flagged and must not be exported as if complete.
  const fail=(o,b,reason)=>{
    errors.push({offset:o,reason,session:owner?owner.id:null,head:[...b.subarray(0,8)].map(x=>x.toString(16).padStart(2,'0')).join(' ')});
    if(owner) owner.errors++;
  };
  for(let o=0;o<d.byteLength;o+=32) {
    const b=new Uint8Array(d.buffer,d.byteOffset+o,32), type=b[0], id=d.getUint32(o+4,true);
    if(b.every(x=>x===255)) continue;
    if(b[1]!==1||type<1||type>4||crc32(b.subarray(0,28))!==d.getUint32(o+28,true)) { fail(o,b,'CRC/Version/Typ'); current=null; continue; }
    if(type===1) {
      const hz=d.getUint16(o+16,true),epoch=d.getBigUint64(o+8,true);
      if(![26,52,104].includes(hz)||!(b[18] in ACCEL_LSB_G)||!(b[19] in GYRO_LSB_DPS)||d.getUint32(o+20,true)!==25||epoch>8640000000000000n) { fail(o,b,'Header'); current=null; continue; }
      current=owner={id,board:boardHex(d.getUint32(o+24,true)),epoch:Number(epoch),hz,ranges:ranges(b[18],b[19]),cal:null,samples:[],complete:false,dropped:null,errors:0}; sessions.push(current);
    } else if(!current||current.id!==id||current.complete) fail(o,b,'Record ohne offene Session');
    else if(type===4) {
      // Calibration valid at START (firmware 0.3.0+), directly after the header.
      if(current.samples.length||current.cal) fail(o,b,'Abgleich an falscher Stelle');
      else try {current.cal=decodeCal(d,o+8,20);} catch {fail(o,b,'Abgleich');}
    }
    else if(type===2) {
      const us=d.getBigUint64(o+8,true);
      if(us>BigInt(Number.MAX_SAFE_INTEGER)|| (current.samples.length && Number(us)<=current.samples.at(-1).us)) { fail(o,b,'Zeitfolge'); continue; }
      current.samples.push({us:Number(us),axes:axes(d,o+16,current.ranges)});
    } else {
      current.complete=true; current.dropped=d.getUint32(o+20,true);
      if(d.getUint32(o+16,true)!==current.samples.length) fail(o,b,'Sample-Anzahl');
    }
  }
  return {sessions,errors};
}
export const exportable=sessions=>sessions.filter(s=>!s.errors);
// Readable summary of decode errors: orphans are ignored, damaged sessions blocked.
export function damageReport({sessions,errors}) {
  const orphans=errors.filter(e=>e.session===null),damaged=sessions.filter(s=>s.errors),parts=[];
  if(orphans.length) {
    const list=orphans.slice(0,3).map(e=>`Offset ${e.offset}: ${e.reason}, Bytes ${e.head}`).join('; ')+(orphans.length>3?'; …':'');
    parts.push(`${orphans.length} ${orphans.length===1?'beschädigter Record':'beschädigte Records'} außerhalb jeder Session ignoriert (${list}). „Logs löschen“ entfernt ${orphans.length===1?'ihn':'sie'}.`);
  }
  if(damaged.length) parts.push(`Beschädigt, CSV gesperrt: ${damaged.map(s=>`#${s.id} (${s.errors} ${s.errors===1?'Record':'Records'})`).join(', ')}.`);
  return parts.join(' ');
}
export function csv(session) {
  return csvAll([session]);
}
export function csvAll(sessions) {
  // Raw sensor axes first (unchanged columns), model axes appended at the end.
  const lines=['session,t_sensor_us,utc_approx,gx_dps,gy_dps,gz_dps,ax_g,ay_g,az_g,session_start_utc_approx,sample_rate_hz,session_complete,session_sample_count,'+BODY_COLUMNS.join(',')+',board_id'];
  for(const session of sessions) for(const s of session.samples) lines.push([
    session.id,s.us,session.epoch?new Date(session.epoch+s.us/1000).toISOString():'',
    ...s.axes.map(x=>x.toFixed(7)),session.epoch?new Date(session.epoch).toISOString():'',
    session.rateEstimated?'':(session.hz??''),session.complete??'',session.samples.length,
    ...bodyAxes(s.axes).map(x=>x.toFixed(7)),session.board??'',
  ].join(','));
  return lines.join('\r\n')+'\r\n';
}
