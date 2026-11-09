// Board IDs (lower 32 bits of the nRF52 DEVICEID, 8 hex digits) and the board LUT
// boards.csv (board_id,name,note), shared with XIAO_eval. Unknown IDs keep their hex form.
export function boardHex(id) {
  return Number.isInteger(id)&&id>0?id.toString(16).padStart(8,'0'):null;
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
    boards.set(id,{name:cells[at('name')]||id,note:at('note')>=0?raw.slice(at('note')).join(',').trim():''});
  }
  return boards;
}
// "Arrow-2 (3fa2c91e)", "3fa2c91e" when not in the LUT, "Board unbekannt" without an ID.
export function boardLabel(hex,boards=new Map()) {
  if(!hex) return 'Board unbekannt';
  const entry=boards.get(hex);
  return entry?`${entry.name} (${hex})`:hex;
}
