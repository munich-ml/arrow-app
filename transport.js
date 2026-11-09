import {UUID,status,startCommand,powerOffCommand,PING,CAPACITY} from './protocol.js';
import {WindowReceiver,windowCommand,WINDOW_SIZE} from './bulk.js';
import {rudderCommand,rudderStatus} from './rudders.js';
import {power} from './power.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export class ArrowDevice {
  constructor(bluetooth=globalThis.navigator?.bluetooth,{idleTimeout=4000,windowTimeout=45000}={}) {
    this.bluetooth=bluetooth;this.busy=false;this.chars={};this.idleTimeout=idleTimeout;this.windowTimeout=windowTimeout;
    this._token=(Math.random()*0xffffffff)>>>0;
  }
  async connect(onStatus,onLive,onDisconnect,onPower) {
    if(!this.bluetooth) throw Error('Web Bluetooth fehlt. Die App in Google Chrome über localhost oder HTTPS öffnen.');
    this._callbacks={onStatus,onLive,onDisconnect,onPower};
    let device;
    try {
      device=await this.bluetooth.requestDevice({filters:[{services:[UUID.service]}]});
    } catch(e) {
      if(e.name==='NotFoundError') throw Error('Kein Gerät ausgewählt: Die Auswahl wurde abgebrochen oder kein Arrow Logger gefunden. Auf dem XIAO muss die Arrow-Firmware laufen; ein Serial-Plotter-Sketch reicht nicht. Board einschalten (blaue LED blinkt alle 2 s), andere BLE-Verbindungen trennen und in Google Chrome erneut suchen.');
      throw e;
    }
    this._adopt(device);
    return this._open();
  }
  get known() { return !!this.device; }
  // Reconnect to the device chosen earlier on this page, without the chooser.
  async reconnect(timeout=8000) {
    if(!this.device) throw Error('Kein bekanntes Gerät');
    let timer;
    const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{this.device.gatt?.disconnect();reject(Error('Zeitüberschreitung beim Verbinden'));},timeout);});
    try {return await Promise.race([this._open(),expired]);} finally {clearTimeout(timer);}
  }
  _adopt(device) {
    if(this.device===device) return;
    this.device=device;this._listening=new WeakSet();
    device.addEventListener('gattserverdisconnected',()=>{this._cancelBulk?.(Error('Bluetooth-Verbindung getrennt'));this.chars={};this._callbacks?.onDisconnect?.();});
  }
  // Characteristic objects may be reused after a reconnect: attach each listener once.
  _listen(char,fn) {
    if(this._listening.has(char)) return;
    this._listening.add(char);
    char.addEventListener('characteristicvaluechanged',e=>{try {fn(e.target.value);}catch(err){console.error(err);}});
  }
  async _open() {
    const {onStatus,onLive,onPower}=this._callbacks||{};
    try {
      const server=await this.device.gatt.connect(), service=await server.getPrimaryService(UUID.service);
      const chars={};
      for(const key of ['control','status','live','download','config']) chars[key]=await service.getCharacteristic(UUID[key]);
      for(const [key,fn] of [['status',v=>onStatus?.(status(v))],['live',v=>onLive?.(v)]]) {
        this._listen(chars[key],fn);await chars[key].startNotifications();
      }
      this.chars=chars;
      const s=await this.getStatus();
      if(s.bulkAvailable) this.chars.bulk=await service.getCharacteristic(UUID.bulk);
      if(s.ruddersAvailable) this.chars.rudders=await service.getCharacteristic(UUID.rudders);
      if(s.powerAvailable) {
        this.chars.power=await service.getCharacteristic(UUID.power);
        this._listen(this.chars.power,v=>onPower?.(power(v)));
        await this.chars.power.startNotifications();
        onPower?.(power(await this.chars.power.readValue()));
      }
      onStatus?.(s); return s;
    } catch(e) { this.disconnect(); throw e; }
  }
  // Keeps the firmware's app lease alive; failures are harmless (next ping or any write).
  async ping() {
    if(this.busy||this._pinging||!this.chars.control) return;
    this._pinging=true;
    try {await this.write(PING);} catch {} finally {this._pinging=false;}
  }
  disconnect() { this._cancelBulk?.(Error('Bluetooth-Verbindung getrennt'));this.device?.gatt?.disconnect(); this.chars={}; }
  async exclusive(fn) {
    if(this.busy) throw Error('Eine Geräteoperation läuft bereits.');
    this.busy=true; try {return await fn();} finally {this.busy=false;}
  }
  async getStatus() { return status(await this.chars.status.readValue()); }
  async getRudders() {
    if(!this.chars.rudders) throw Error('Rudersteuerung benötigt die aktuelle Firmware. Bitte xiao_sense hochladen.');
    return rudderStatus(await this.chars.rudders.readValue());
  }
  setRudders(mode,channels) {return this.exclusive(async()=>{
    if(!this.chars.rudders) throw Error('Rudersteuerung benötigt die aktuelle Firmware. Bitte xiao_sense hochladen.');
    const token=this._token=(this._token+1)>>>0||1;
    await this.write(rudderCommand(token,mode,channels));
    const end=Date.now()+2500;
    do {
      const value=await this.getRudders();
      if(value.token===token) {
        if(value.result) throw Error(['','Ungültige Ruderwerte','Ruder nicht aktiv oder Gerät beschäftigt','PWM-Hardware nicht verfügbar'][value.result]);
        return value;
      }
      await pause(30);
    } while(Date.now()<end);
    throw Error('Keine Bestätigung der Rudersteuerung');
  });}
  async write(bytes) { await this.chars.control.writeValueWithResponse(bytes); }
  async waitFor(predicate,timeout=5000) {
    const end=Date.now()+timeout;
    do { const s=await this.getStatus(); if(predicate(s)) return s;
      if(s.error && s.state!==2) throw Error(`Gerätefehler ${s.error}`);
      await pause(80);
    } while(Date.now()<end);
    throw Error('Zeitüberschreitung; Gerätestatus erneut lesen.');
  }
  // hz: rate chosen in the app. Applied before START when the board still has another
  // one (Config is RAM only, 104 Hz after boot from 0.2.6, 52 Hz before), so the header records what was chosen.
  start(hz) { return this.exclusive(async()=>{
    const before=await this.getStatus(); if(before.state!==0) throw Error('Start nur im Leerlauf');
    if(hz!==undefined&&(await this.chars.config.readValue()).getUint16(0,true)!==hz) await this.applyRate(hz);
    await this.write(startCommand());
    return this.waitFor(s=>s.state===1&&s.session===before.session+1);
  }); }
  stop() { return this.exclusive(async()=>{await this.write(Uint8Array.of(2)); return this.waitFor(s=>s.state===0);}); }
  setRate(hz) { return this.exclusive(()=>this.applyRate(hz)); }
  async applyRate(hz) {
    if(![26,52,104].includes(hz)) throw Error('Ungültige Rate');
    if((await this.getStatus()).state!==0) throw Error('Konfiguration nur im Leerlauf');
    await this.chars.config.writeValueWithResponse(Uint8Array.of(hz,0));
    // Callback queues work; wait for the applied configuration, not the write ACK.
    await pause(100);
    const s=await this.getStatus(),v=await this.chars.config.readValue();
    if(s.error||v.getUint16(0,true)!==hz) throw Error('Konfiguration nicht übernommen');
  }
  powerOff() { return this.exclusive(async()=>{
    const s=await this.getStatus();
    if(!s.offAvailable) throw Error('Ausschalten benötigt Firmware 0.2.3. Bitte xiao_sense hochladen.');
    if(![0,3].includes(s.state)) throw Error('Erst Aufzeichnung/Download/Löschen beenden');
    try {await this.write(powerOffCommand());}
    catch(e) {if(!this.chars.control) return; throw e;} // link already dropped: switched off
    // Success is the disconnect (about 0.5 s); a busy board answers with error 2 instead.
    const end=Date.now()+3000;
    await pause(200);
    while(this.chars.control&&Date.now()<end) {
      let st;try {st=await this.getStatus();}catch(e) {if(!this.chars.control) return; throw e;}
      if(st.error===2) throw Error('Ausschalten abgelehnt: Gerät beschäftigt');
      await pause(100);
    }
    if(this.chars.control) throw Error('XIAO hat die Verbindung nicht beendet. Status prüfen.');
  }); }
  erase() { return this.exclusive(async()=>{
    const s=await this.getStatus(); if(![0,3].includes(s.state)) throw Error('Erst Aufzeichnung/Download beenden');
    await this.write(Uint8Array.of(3,0x53,0x41,0x52,0x45));
    // Distinguish completion even when an already empty flash was erased.
    await pause(150);
    return this.waitFor(v=>v.state===0&&v.used===0&&v.error===0,180000);
  }); }
  async downloadAll(onProgress=()=>{},signal) {
    return this.exclusive(async()=>{
      let snapshot=await this.getStatus();
      if(!snapshot.bulkAvailable||!this.chars.bulk) throw Error('Schneller Download benötigt die neue Arrow-Firmware. In PlatformIO erneut Upload ausführen und die Web-App neu laden.');
      if(snapshot.state===4) {await this.write(Uint8Array.of(6));snapshot=await this.waitFor(s=>s.state===0);}
      if(snapshot.state!==0) throw Error('Download nur nach Stopp');
      if(snapshot.used>CAPACITY) throw Error('Unzulässige Datenmenge');
      if(signal?.aborted) throw Error('Download abgebrochen');
      const bytes=new Uint8Array(snapshot.used),bulk=this.chars.bulk;
      const started=Date.now();let locked=false,subscribed=false;
      const report=(received,done=false)=>{
        const seconds=Math.max(.001,(Date.now()-started)/1000),speed=received/seconds;
        onProgress(done?1:Math.min(.99,received/bytes.length||0),{
          receivedBytes:received,totalBytes:bytes.length,bytesPerSecond:speed,
          etaSeconds:speed?(bytes.length-received)/speed:null,mode:'stream',verified:done,
        });
      };
      const listener=e=>this._bulkSink?.(e.target.value);
      bulk.addEventListener('characteristicvaluechanged',listener);
      try {
        await bulk.startNotifications();subscribed=true;
        for(let offset=0;offset<bytes.length;offset+=WINDOW_SIZE) {
          const length=Math.min(WINDOW_SIZE,bytes.length-offset);let received,lastError;
          for(let attempt=0;attempt<3&&!received;attempt++) {
            if(signal?.aborted) throw Error('Download abgebrochen');
            const token=this._token=(this._token+1)>>>0||1;
            try {
              locked=true;
              received=await this._receiveWindow(token,offset,length,signal,n=>report(offset+n));
            } catch(e) {
              if(signal?.aborted||!this.chars.bulk) throw e;
              lastError=e;
              const current=await this.getStatus();
              if(current.state===3||current.error) throw Error(`Gerätefehler ${current.error}: ${e.message}`);
            }
          }
          if(!received) throw Error(`Download bei Byte ${offset} fehlgeschlagen: ${lastError?.message}`);
          bytes.set(received,offset);
        }
        const after=await this.getStatus();
        if(after.used!==snapshot.used||after.session!==snapshot.session||after.state!==(bytes.length?4:0)) throw Error('Log während Download verändert');
        if(locked) {await this.write(Uint8Array.of(6));await this.waitFor(s=>s.state===0);locked=false;}
        report(bytes.length,true);return bytes;
      } finally {
        if(locked&&this.chars.control) {try {await this.write(Uint8Array.of(6));}catch{ /* disconnect/firmware timeout also release lock */ }}
        bulk.removeEventListener('characteristicvaluechanged',listener);
        if(subscribed) {try {await bulk.stopNotifications();}catch{ /* disconnected */ }}
      }
    });
  }
  listSessions() { return this.exclusive(async()=>{
    const before=await this.getStatus();
    if(!before.catalogAvailable) throw Error('Sessionübersicht benötigt die aktuelle Firmware. Bitte xiao_sense erneut hochladen.');
    if(![0,3].includes(before.state)) throw Error('Sessionübersicht erst nach Stopp aktualisieren.');
    const sessions=[];let cursor=0;
    while(cursor<before.used) {
      const token=this._token=(this._token+1)>>>0||1;
      const bytes=new Uint8Array(9),d=new DataView(bytes.buffer);
      bytes[0]=7;d.setUint32(1,token,true);d.setUint32(5,cursor,true);
      await this.write(bytes);
      const deadline=Date.now()+30000;let row;
      do {
        row=await this.chars.download.readValue();
        if(row.byteLength===20&&row.getUint32(0,true)===token) break;
        const current=await this.getStatus();
        if(current.state!==before.state||current.error!==before.error) throw Error('Sessionübersicht konnte nicht gelesen werden.');
        await pause(60);
      } while(Date.now()<deadline);
      if(row.byteLength!==20||row.getUint32(0,true)!==token) throw Error('Zeitüberschreitung beim Lesen der Sessionübersicht.');
      const id=row.getUint32(4,true),epoch=row.getBigUint64(8,true),size=row.getUint32(16,true);
      if(!id) {if(size) throw Error('Ungültiges Ende der Sessionübersicht');break;}
      if(!size||size%32||size>before.used-cursor||epoch>8640000000000000n||sessions.some(s=>s.id===id)) throw Error('Ungültige Sessionübersicht');
      sessions.push({id,epoch:Number(epoch),size});cursor+=size;
    }
    const after=await this.getStatus();
    if(after.used!==before.used||after.session!==before.session||after.state!==before.state) throw Error('Speicher wurde während der Abfrage verändert. Bitte aktualisieren.');
    return sessions;
  }); }
  async _receiveWindow(token,offset,length,signal,onBytes) {
    const receiver=new WindowReceiver(token,offset,length);
    let idleTimer,totalTimer,fail;
    const pending=new Promise((resolve,reject)=>{
      fail=reject;
      const refresh=()=>{clearTimeout(idleTimer);idleTimer=setTimeout(()=>reject(Error('Keine Download-Daten empfangen')),this.idleTimeout);};
      this._bulkSink=value=>{
        try {
          if(!receiver.feed(value)) return;
          refresh();onBytes(receiver.received);
          if(receiver.done) resolve(receiver.bytes);
        } catch(e) {reject(e);}
      };
      this._cancelBulk=reject;
      refresh();totalTimer=setTimeout(()=>reject(Error('Downloadfenster dauert zu lange')),this.windowTimeout);
    });
    const cancel=()=>fail(Error('Download abgebrochen'));
    signal?.addEventListener('abort',cancel,{once:true});
    try {
      if(signal?.aborted) cancel();
      // Wait for BOTH write ACK and data. Notifications can precede the ACK.
      const [,received]=await Promise.all([this.write(windowCommand(token,offset,length)),pending]);
      return received;
    } finally {
      clearTimeout(idleTimer);clearTimeout(totalTimer);
      signal?.removeEventListener('abort',cancel);this._bulkSink=null;this._cancelBulk=null;
    }
  }
}
