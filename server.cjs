// Loopback-only host. Resized pixels go to the bundled local engine in memory;
// there is no cloud connection or upload to any remote server.
'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),{spawn}=require('child_process'),{Worker}=require('worker_threads');
const root=__dirname;
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.wasm':'application/wasm','.onnx':'application/octet-stream','.icc':'application/vnd.iccprofile','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'};
let lastSeen=Date.now(),base='',inferenceWorker=null,pending=null,inferenceId=0;
const storeDirectory=path.join(root,'user-data'),storeFile=path.join(storeDirectory,'brand-store.json');
let storeWrite=Promise.resolve();
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function plain(value){return value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;}
function validKeys(value,allowed){return plain(value)&&Object.keys(value).every(key=>allowed.includes(key));}
function shortText(value,max){return typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);}
function validateStore(value){
 if(!validKeys(value,['version','logos','templates'])||value.version!==1||!Array.isArray(value.logos)||!Array.isArray(value.templates)||value.logos.length>12||value.templates.length>20)throw new Error('品牌模板格式无效。');
 let nodes=0;
 function safeJSON(item,depth=0){
  if(++nodes>50000||depth>16)throw new Error('模板设置过于复杂。');
  if(item===null||typeof item==='boolean'||typeof item==='string')return;
  if(typeof item==='number'&&Number.isFinite(item))return;
  if(Array.isArray(item)){for(const entry of item)safeJSON(entry,depth+1);return;}
  if(plain(item)){for(const [key,entry]of Object.entries(item)){if(['__proto__','prototype','constructor'].includes(key))throw new Error('模板设置含有无效字段。');safeJSON(entry,depth+1);}return;}
  throw new Error('模板设置必须是有效的 JSON。');
 }
 const logoIds=new Set(),templateIds=new Set();
 for(const logo of value.logos){
  if(!validKeys(logo,['id','name','dataUrl'])||!shortText(logo.id,128)||!shortText(logo.name,120)||logoIds.has(logo.id)||typeof logo.dataUrl!=='string'||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(logo.dataUrl))throw new Error('Logo 格式无效，请使用 PNG。');
  const encoded=logo.dataUrl.slice(22);if(encoded.length%4!==0||encoded.length>Math.ceil(5*1024*1024/3)*4)throw new Error('Logo 文件不能超过 5 MB。');
  const png=Buffer.from(encoded,'base64');
  if(png.length>5*1024*1024||png.length<33||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||png.toString('ascii',12,16)!=='IHDR')throw new Error('Logo 不是有效的 PNG 文件。');
  logoIds.add(logo.id);
 }
 for(const template of value.templates){
  if(!validKeys(template,['id','name','settings'])||!shortText(template.id,128)||!shortText(template.name,120)||templateIds.has(template.id)||!plain(template.settings))throw new Error('品牌模板格式无效。');
  safeJSON(template.settings);templateIds.add(template.id);
 }
 return value;
}
async function checkStorePath(){
 for(const file of [storeDirectory,storeFile]){try{if((await fs.promises.lstat(file)).isSymbolicLink())throw new Error('品牌模板路径无效。');}catch(error){if(error.code!=='ENOENT')throw error;}}
}
async function readStore(){
 await checkStorePath();
 try{const stat=await fs.promises.stat(storeFile);if(!stat.isFile()||stat.size>10*1024*1024)throw new Error('品牌模板文件无效。');return validateStore(JSON.parse(await fs.promises.readFile(storeFile,'utf8')));}
 catch(error){if(error.code==='ENOENT')return{version:1,logos:[],templates:[]};throw error;}
}
function writeStore(value){
 const operation=storeWrite.then(async()=>{
  await checkStorePath();await fs.promises.mkdir(storeDirectory,{recursive:true});await checkStorePath();
  const temporary=path.join(storeDirectory,`brand-store.${process.pid}.${require('crypto').randomUUID()}.tmp`);
  try{await fs.promises.writeFile(temporary,JSON.stringify(value),{encoding:'utf8',flag:'wx'});await fs.promises.rename(temporary,storeFile);}finally{await fs.promises.unlink(temporary).catch(()=>{});}
  return value;
 });
 storeWrite=operation.catch(()=>{});return operation;
}
function clearInference(){inferenceWorker?.terminate();inferenceWorker=null;}
// The worker starts loading the model as soon as it is created, so starting it early hides the first-photo wait.
function startWorker(){
 if(inferenceWorker)return;
 inferenceWorker=new Worker(path.join(root,'native-inference.cjs'));
 const activeWorker=inferenceWorker;
 inferenceWorker.on('message',m=>{if(inferenceWorker!==activeWorker||!pending||pending.id!==m.id)return;const p=pending;pending=null;clearTimeout(p.timer);lastSeen=Date.now();m.error?p.reject(new Error(m.error)):p.resolve(m.mask);});
 inferenceWorker.on('error',e=>{if(inferenceWorker!==activeWorker)return;if(pending){clearTimeout(pending.timer);pending.reject(e);pending=null;}clearInference();});
 inferenceWorker.on('exit',code=>{if(inferenceWorker!==activeWorker)return;if(code!==0&&pending){clearTimeout(pending.timer);pending.reject(new Error('识别进程已结束，请重试。'));pending=null;}inferenceWorker=null;});
}
function infer(rgba){return new Promise((resolve,reject)=>{
 if(pending){reject(new Error('上一张照片仍在处理中，请稍候。'));return;}
 startWorker();
 const id=++inferenceId;pending={id,resolve,reject,timer:setTimeout(()=>{if(pending?.id===id){pending=null;clearInference();reject(new Error('识别超时，请关闭其他占用较多内存的程序后重试。'));}},240000)};
 inferenceWorker.postMessage({id,rgba},[rgba.buffer]);
});}
const server=http.createServer((req,res)=>{
 res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
 if(req.headers.host!==new URL(base).host){res.writeHead(403);res.end();return;}
 if(req.url==='/brand-store'){
  lastSeen=Date.now();
  if(req.method==='GET'){readStore().then(value=>json(res,200,value)).catch(()=>json(res,500,{error:'无法读取品牌模板。请检查 user-data 文件夹，原有文件已保留。'}));return;}
  if(req.method!=='PUT'){res.writeHead(405,{'Allow':'GET, PUT'});res.end();return;}
  if(req.headers.origin!==base||req.headers['x-qingtu']!=='1'||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']||'')){res.writeHead(403);res.end();return;}
  const limit=10*1024*1024,chunks=[];let bytes=0,rejected=false;
  if(Number(req.headers['content-length'])>limit){json(res,413,{error:'品牌素材总大小不能超过 10 MB。'});req.resume();return;}
  req.on('error',()=>{});
  req.on('data',chunk=>{if(rejected)return;bytes+=chunk.length;if(bytes>limit){rejected=true;json(res,413,{error:'品牌素材总大小不能超过 10 MB。'});}else chunks.push(chunk);});
  req.on('end',async()=>{
   if(rejected)return;let value;try{value=validateStore(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(error){json(res,400,{error:error instanceof SyntaxError?'品牌模板必须是有效的 JSON。':error.message});return;}
   try{await writeStore(value);if(!res.destroyed)json(res,200,value);}catch{if(!res.destroyed)json(res,500,{error:'无法保存品牌模板，请确认工具文件夹可以写入。'});}
  });return;
 }
 if(req.url==='/capabilities'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"native":true,"app":"qingtu-gray"}');return;}
 if(req.url==='/infer'&&req.method==='POST'){
  if(req.headers.origin!==base||req.headers['x-qingtu']!=='1'||req.headers['content-type']!=='application/octet-stream'){res.writeHead(403);res.end();return;}
  if(pending){res.writeHead(429,{'Content-Type':'application/json'});res.end('{"error":"上一张照片仍在处理中，请稍候。"}');return;}
  const size=4*1024*1024,chunks=[];let bytes=0,rejected=false;lastSeen=Date.now();
  req.on('error',()=>{});
  req.on('data',chunk=>{if(rejected)return;bytes+=chunk.length;if(bytes>size){rejected=true;res.writeHead(413);res.end();req.destroy();}else chunks.push(chunk)});
  req.on('end',async()=>{if(rejected)return;if(bytes!==size){res.writeHead(400);res.end();return;}try{const rgba=new Uint8ClampedArray(Buffer.concat(chunks));const mask=await infer(rgba);if(res.destroyed)return;res.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'no-store'});res.end(Buffer.from(mask.buffer));}catch(e){if(res.destroyed)return;res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}});return;
 }
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
 let name;try{name=decodeURIComponent(new URL(req.url,base).pathname)}catch{res.writeHead(400);res.end();return;}
 if(name==='/alive'){lastSeen=Date.now();res.writeHead(200,{'Content-Type':'application/json'});res.end('{"app":"qingtu-gray","version":7}');return;}
 if(name==='/')name='/index.html';
 const file=path.resolve(root,'.'+name);
 const relative=path.relative(root,file).replace(/\\/g,'/');
 if(!file.startsWith(root+path.sep)||relative.toLowerCase()==='user-data'||relative.toLowerCase().startsWith('user-data/')||!mime[path.extname(file).toLowerCase()]||['server.cjs'].includes(path.basename(file))){res.writeHead(404);res.end();return;}
 fs.stat(file,(err,stat)=>{
  if(err||!stat.isFile()){res.writeHead(404);res.end();return;}
  lastSeen=Date.now();res.writeHead(200,{'Content-Type':mime[path.extname(file).toLowerCase()],'Content-Length':stat.size,'Cache-Control':name.startsWith('/models/')||name.startsWith('/vendor/')?'private, max-age=86400':'no-cache'});
  if(req.method==='HEAD'){res.end();return;}const stream=fs.createReadStream(file);stream.on('error',()=>res.destroy());stream.pipe(res);
 });
});
server.listen(Number(process.env.QINGTU_PORT||0),'127.0.0.1',()=>{
 base=`http://127.0.0.1:${server.address().port}`;console.log(base);startWorker();
 if(!process.argv.includes('--no-open')){
  // This opens the user's interactive browser; the helper itself stays hidden.
  const edge=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  const chrome='C:/Program Files/Google/Chrome/Application/chrome.exe';
  const exe=edge||(fs.existsSync(chrome)?chrome:'rundll32.exe');
  const args=exe==='rundll32.exe'?['url.dll,FileProtocolHandler',base]:['--new-window',base];
  const child=spawn(exe,args,{detached:true,stdio:'ignore',windowsHide:true});child.on('error',()=>{});child.unref();
 }
});
server.on('error',err=>{console.error(err.message);process.exit(1)});
setInterval(()=>{if(!pending&&Date.now()-lastSeen>12*60*1000){clearInference();server.close(()=>process.exit(0));}},30000).unref();
