// Board IDs (lower 32 bits of the nRF52 DEVICEID, 8 hex digits) and the board LUT
// boards.csv, shared with XIAO_eval (arrow_eval/boards.py). Unknown IDs keep their hex form.
// Columns: board_id,name, IMU calibration (CAL_COLUMNS, empty = not calibrated), note.
// note stays last and may contain commas.
import {emptyCal,withAccel,withGyro,physical} from './imucal.js';
export const ACCEL_COLUMNS=['ax_off_g','ay_off_g','az_off_g','ax_scale','ay_scale','az_scale'];
export const GYRO_COLUMNS=['gx_bias_dps','gy_bias_dps','gz_bias_dps'];
export const CAL_COLUMNS=['accel_cal',...ACCEL_COLUMNS,'gyro_cal',...GYRO_COLUMNS];
export function boardHex(id) {
  return Number.isInteger(id)&&id>0?id.toString(16).padStart(8,'0'):null;
}
const toTime=text=>{
  if(!text) return 0;
  const t=Date.parse(text);if(!Number.isFinite(t)) throw Error(`boards.csv: ungültiger Zeitpunkt ${text}`);
  return Math.floor(t/1000);
};
const isoTime=s=>s?new Date(s*1000).toISOString().replace(/\.\d{3}Z$/,'Z'):'';
function parseCal(cells,id) {
  const accel=ACCEL_COLUMNS.map(c=>cells[c]??''),gyro=GYRO_COLUMNS.map(c=>cells[c]??'');
  for(const part of [accel,gyro]) if(part.some(Boolean)&&!part.every(Boolean)) throw Error(`boards.csv: Abgleich von ${id} unvollständig`);
  if(!accel.every(Boolean)&&!gyro.every(Boolean)) return null;
  const num=v=>{const x=Number(v);if(!Number.isFinite(x)) throw Error(`boards.csv: ungültiger Wert ${v} bei ${id}`);return x;};
  let cal=emptyCal();
  try {
    if(accel.every(Boolean)) cal=withAccel(cal,accel.slice(0,3).map(num),accel.slice(3).map(num),toTime(cells.accel_cal));
    if(gyro.every(Boolean)) cal=withGyro(cal,gyro.map(num),toTime(cells.gyro_cal));
  } catch(e) {throw Error(`boards.csv: Abgleich von ${id}: ${e.message}`);}
  return cal;
}
export function parseBoards(text) {
  const lines=text.replace(/^﻿/,'').split(/\r?\n/).filter(l=>l.trim()&&!l.trim().startsWith('#'));
  const header=(lines.shift()||'').split(',').map(v=>v.trim());
  const at=name=>header.indexOf(name);
  if(at('board_id')<0||at('name')<0) throw Error('boards.csv: Spalten board_id,name fehlen');
  const boards=new Map();
  for(const line of lines) {
    const raw=line.split(','),cells=raw.map(v=>v.trim()),id=cells[at('board_id')]?.toLowerCase();
    if(!/^[0-9a-f]{8}$/.test(id||'')) throw Error(`boards.csv: ungültige board_id ${cells[at('board_id')]}`);
    if(boards.has(id)) throw Error(`boards.csv: board_id ${id} doppelt`);
    const named=Object.fromEntries(header.map((h,i)=>[h,cells[i]??'']).filter(([h])=>CAL_COLUMNS.includes(h)));
    boards.set(id,{name:cells[at('name')]||id,note:at('note')>=0?raw.slice(at('note')).join(',').trim():'',cal:parseCal(named,id)});
  }
  return boards;
}
// Full file with all columns; values exactly at the fixed-point resolution of the XIAO.
export function serializeBoards(boards) {
  const lines=[['board_id','name',...CAL_COLUMNS,'note'].join(',')];
  for(const [id,b] of boards) {
    const c=b.cal,p=c&&physical(c),accel=c?.accel,gyro=c?.gyro;
    const fixed=(v,n)=>v.toFixed(n).replace(/^-(0\.0*)$/,'$1');
    lines.push([id,b.name.replace(/,/g,' '),
      accel?isoTime(c.accelTime):'',...(accel?[...p.offset.map(v=>fixed(v,4)),...p.scale.map(v=>fixed(v,5))]:Array(6).fill('')),
      gyro?isoTime(c.gyroTime):'',...(gyro?p.bias.map(v=>fixed(v,3)):Array(3).fill('')),
      b.note||''].join(','));
  }
  return lines.join('\n')+'\n';
}
// "Arrow-2 (3fa2c91e)", "3fa2c91e" when not in the LUT, "Board unbekannt" without an ID.
export function boardLabel(hex,boards=new Map()) {
  if(!hex) return 'Board unbekannt';
  const entry=boards.get(hex);
  return entry?`${entry.name} (${hex})`:hex;
}
