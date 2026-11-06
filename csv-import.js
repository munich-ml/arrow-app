const AXES=['gx_dps','gy_dps','gz_dps','ax_g','ay_g','az_g'];
const REQUIRED=['session','t_sensor_us','utc_approx',...AXES];
// RFC 4180-style fields, with BOM and semicolon support for local CSV workflows.
function rows(text) {
  text=text.replace(/^\uFEFF/,'');
  const first=text.split(/\r?\n/,1)[0],delimiter=first.includes(';')?';':',';
  const result=[];let row=[],field='',quoted=false,closed=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(quoted) {
      if(c==='"') {if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}
      else field+=c;
    } else if(c==='"') {
      if(field||closed) throw Error('Ungültige CSV-Anführungszeichen');quoted=true;
    } else if(c===delimiter||c==='\n'||c==='\r') {
      row.push(field);field='';closed=false;
      if(c!==delimiter) {if(c==='\r'&&text[i+1]==='\n')i++;if(row.some(v=>v.trim()))result.push(row);row=[];}
    } else {
      if(closed&&!/\s/.test(c))throw Error('Ungültiges Zeichen nach CSV-Feld');
      if(!closed)field+=c;
    }
  }
  if(quoted)throw Error('CSV-Anführungszeichen nicht geschlossen');
  row.push(field);if(row.some(v=>v.trim()))result.push(row);return result;
}
function number(value,name,{integer=false,min=-Infinity,max=Infinity}={}) {
  const n=Number(value);
  if(!value.trim()||!Number.isFinite(n)||(integer&&!Number.isSafeInteger(n))||n<min||n>max) throw Error(`Ungültiger CSV-Wert für ${name}`);
  return n;
}
function utc(value,name) {
  if(!value)return null;
  const epoch=Date.parse(value);
  if(!value.endsWith('Z')||!Number.isFinite(epoch))throw Error(`Ungültige UTC-Zeit für ${name}`);
  return epoch;
}
export function parseCsv(text) {
  const table=rows(text);if(table.length<2)throw Error('CSV enthält keine Messwerte');
  if(table.length>200001)throw Error('CSV enthält zu viele Messwerte');
  const header=table.shift().map(v=>v.trim());
  if(new Set(header).size!==header.length)throw Error('Doppelte CSV-Spalten');
  for(const col of REQUIRED)if(!header.includes(col))throw Error(`CSV-Spalte fehlt: ${col}`);
  const result=new Map();
  for(const row of table) {
    if(row.length!==header.length)throw Error('CSV-Zeile hat eine falsche Spaltenanzahl');
    const values=Object.fromEntries(header.map((key,i)=>[key,row[i].trim()]));
    const id=number(values.session,'session',{integer:true,min:1,max:0xffffffff});
    const us=number(values.t_sensor_us,'t_sensor_us',{integer:true,min:0});
    const epoch=utc(values.utc_approx,'utc_approx');
    const metadata=[values.session_start_utc_approx??'',values.sample_rate_hz??'',values.session_complete??'',values.session_sample_count??''];
    let session=result.get(id);
    if(!session) {
      const [start,hz,complete,count]=metadata;
      if(!['','true','false'].includes(complete))throw Error('Ungültiger CSV-Sessionabschluss');
      session={id,epoch:utc(start,'session_start_utc_approx')??(epoch===null?0:epoch-us/1000),
        hz:hz?number(hz,'sample_rate_hz',{min:Number.MIN_VALUE}):null,rateEstimated:!hz,
        complete:complete===''?null:complete==='true',samples:[],dropped:null,
        _metadata:metadata.join('|'),_expected:count?number(count,'session_sample_count',{integer:true,min:1}):null};
      result.set(id,session);
    }
    if(metadata.join('|')!==session._metadata)throw Error('Widersprüchliche CSV-Sessionmetadaten');
    if(session.samples.length&&us<=session.samples.at(-1).us)throw Error('CSV-Sensorzeiten sind doppelt oder rückwärts');
    if(metadata[0]&&epoch!==null&&Math.abs(epoch-(session.epoch+us/1000))>1.001)throw Error('CSV-Zeit stimmt nicht mit dem Sessionstart überein');
    session.samples.push({us,axes:AXES.map(axis=>number(values[axis],axis))});
  }
  for(const session of result.values()) {
    if(session._expected!==null&&session._expected!==session.samples.length)throw Error('CSV unvollständig: Sample-Anzahl stimmt nicht');
    if(!session.hz&&session.samples.length>1) {
      const dt=session.samples.slice(1).map((s,i)=>s.us-session.samples[i].us).sort((a,b)=>a-b);
      const i=Math.floor(dt.length/2),median=dt.length%2?dt[i]:(dt[i-1]+dt[i])/2;
      session.hz=Math.round(1e7/median)/10;
    }
    delete session._expected;delete session._metadata;
  }
  return {sessions:[...result.values()],errors:[]};
}
