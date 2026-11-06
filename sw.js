// Offline support. Network first, so an online start always gets the current version;
// without network (or after 4 s) the cached copy is used. Keep FILES in sync with web/
// (tests/pwa.test.js checks it).
const CACHE='arrow-app';
const FILES=['./','index.html','style.css','manifest.webmanifest','icon-192.png','icon-512.png',
  'app.js','battery-history.js','bulk.js','csv-import.js','mount.js','naming.js','power.js',
  'protocol.js','rudders.js','timeaxis.js','transport.js'];
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim()));
});
async function networkFirst(request) {
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),4000);
  try {
    const response=await fetch(request,{signal:abort.signal});
    if(response.ok) {const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(request,copy));}
    return response;
  } catch {
    return await caches.match(request,{ignoreSearch:true})||await caches.match('index.html')||Response.error();
  } finally {clearTimeout(timer);}
}
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET'||new URL(request.url).origin!==self.location.origin) return;
  event.respondWith(networkFirst(request));
});
