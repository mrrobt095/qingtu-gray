(() => {
 'use strict';
 // Local browser storage (IndexedDB) for two things:
 // - masks: recognition results keyed by a hash of the model input, so the same photo never runs the model twice;
 // - photos/edits/meta: the current batch, restored after a refresh or restart. Files are written once;
 //   settings and shadow strokes live in a separate small record so frequent edits never rewrite the photo.
 // The server keeps a fixed port so this storage survives restarts. Every call fails soft: without storage the tool works as before.
 const DB_NAME='qingtu-session',DB_VERSION=1,MASK_VERSION='birefnet-tiny-1',MAX_MASKS=160;
 let dbPromise=null;
 function open(){
  if(!dbPromise)dbPromise=new Promise((resolve,reject)=>{
   if(!window.indexedDB||location.protocol==='file:'){reject(new Error('no storage'));return;}
   const request=indexedDB.open(DB_NAME,DB_VERSION);
   request.onupgradeneeded=()=>{const db=request.result;db.createObjectStore('masks').createIndex('t','t');db.createObjectStore('photos',{keyPath:'uid'});db.createObjectStore('edits');db.createObjectStore('meta');};
   request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('storage blocked'));
  });
  return dbPromise;
 }
 // Runs work(transaction) and resolves with whatever work hands to done() once the transaction commits.
 function tx(stores,mode,work){return open().then(db=>new Promise((resolve,reject)=>{const t=db.transaction(stores,mode);let value;try{work(t,v=>{value=v;});}catch(e){reject(e);}t.oncomplete=()=>resolve(value);t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error);}));}
 function get(store,key){return tx(store,'readonly',(t,done)=>{const r=t.objectStore(store).get(key);r.onsuccess=()=>done(r.result);});}
 function getAll(store){return tx(store,'readonly',(t,done)=>{const r=t.objectStore(store).getAll();r.onsuccess=()=>done(r.result);});}
 async function maskKey(rgba){const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',rgba));return MASK_VERSION+':'+Array.from(hash,b=>b.toString(16).padStart(2,'0')).join('');}
 async function getMask(key){try{const v=await get('masks',key);return v?.mask instanceof Uint8Array?v.mask:null;}catch{return null;}}
 async function putMask(key,mask){
  try{
   // Store, then drop the oldest entries beyond MAX_MASKS (about 1 MB each), walking the timestamp index only.
   await tx('masks','readwrite',t=>{
    const s=t.objectStore('masks');s.put({mask,t:Date.now()},key);
    const count=s.count();
    count.onsuccess=()=>{let extra=count.result-MAX_MASKS;if(extra<=0)return;const cursor=s.index('t').openKeyCursor();cursor.onsuccess=()=>{const c=cursor.result;if(!c||extra<=0)return;s.delete(c.primaryKey);extra--;c.continue();};};
   });
  }catch{}
 }
 async function savePhoto(photo,edits){try{await tx(['photos','edits'],'readwrite',t=>{t.objectStore('photos').put(photo);t.objectStore('edits').put(edits,photo.uid);});return true;}catch{return false;}}
 async function saveEdits(uid,edits){try{await tx('edits','readwrite',t=>{t.objectStore('edits').put(edits,uid);});}catch{}}
 async function removePhoto(uid){try{await tx(['photos','edits'],'readwrite',t=>{t.objectStore('photos').delete(uid);t.objectStore('edits').delete(uid);});}catch{}}
 async function clearPhotos(){try{await tx(['photos','edits'],'readwrite',t=>{t.objectStore('photos').clear();t.objectStore('edits').clear();});}catch{}}
 async function loadPhotos(){
  try{
   const photos=(await getAll('photos')||[]).filter(x=>x?.uid&&x.file instanceof Blob).sort((a,b)=>a.order-b.order);
   return await Promise.all(photos.map(async p=>({...p,edits:await get('edits',p.uid).catch(()=>null)})));
  }catch{return [];}
 }
 async function saveMeta(value){try{await tx('meta','readwrite',t=>{t.objectStore('meta').put(value,'state');});}catch{}}
 async function loadMeta(){try{return await get('meta','state')||null;}catch{return null;}}
 async function available(){try{await open();return true;}catch{return false;}}
 globalThis.GraySession={maskKey,getMask,putMask,savePhoto,saveEdits,removePhoto,clearPhotos,loadPhotos,saveMeta,loadMeta,available};
})();
