(() => {
 'use strict';
 const SIZE=1024;
 let nativeAvailable;
 // Masks are stored as 8-bit alpha. Fresh results are rounded the same way, so a cached photo renders exactly like the first time.
 function toFloat(bytes){const mask=new Float32Array(bytes.length);for(let i=0;i<bytes.length;i++)mask[i]=bytes[i]/255;return mask;}
 async function identify(rgba,onProgress){
  if(location.protocol==='file:')throw new Error('请关闭此页面，双击文件夹中的“启动工具.cmd”打开工具。');
  const session=globalThis.GraySession,key=session?await session.maskKey(rgba).catch(()=>null):null;
  const cached=key?await session.getMask(key):null;
  if(cached?.length===SIZE*SIZE)return toFloat(cached);
  if(nativeAvailable===undefined)nativeAvailable=await fetch('capabilities').then(r=>r.ok?r.json():null).then(v=>v?.native===true).catch(()=>false);
  if(!nativeAvailable)throw new Error('本地识别服务未启动，请重新双击“启动工具.cmd”。');
  onProgress('正在识别鞋子轮廓，首次处理请稍候…');
  let response;try{response=await fetch('infer',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Qingtu':'1'},body:rgba,signal:AbortSignal.timeout(250000)});}catch(e){throw new Error(e.name==='TimeoutError'?'这张照片处理超时，请关闭占用较多内存的程序后重试。':'本地连接已关闭，请重新双击“启动工具.cmd”。');}
  if(!response.ok){const data=await response.json().catch(()=>({error:'本地识别未完成，请重试。'}));throw new Error(data.error);}
  const buf=await response.arrayBuffer();if(buf.byteLength!==1024*1024*4)throw new Error('识别结果不完整，请重试。');
  const raw=new Float32Array(buf),bytes=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)bytes[i]=Math.round(Math.max(0,Math.min(1,raw[i]))*255);
  if(key)session.putMask(key,bytes);
  return toFloat(bytes);
 }
 if(location.protocol!=='file:')setInterval(()=>fetch('alive').catch(()=>{}),30000);
 function mainComponents(mask){
  const n=mask.length,labels=new Int32Array(n),queue=new Int32Array(n),components=[];
  let label=0;
  for(let i=0;i<n;i++){
   if(labels[i]||mask[i]<.5)continue;
   label++;let head=0,tail=1;queue[0]=i;labels[i]=label;
   let minX=SIZE,minY=SIZE,maxX=0,maxY=0,sx=0,sy=0,border=false;
   while(head<tail){const p=queue[head++],x=p%SIZE,y=(p/SIZE)|0;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);sx+=x;sy+=y;if(x<2||y<2||x>SIZE-3||y>SIZE-3)border=true;
    const ns=[x?p-1:-1,x<SIZE-1?p+1:-1,y?p-SIZE:-1,y<SIZE-1?p+SIZE:-1];
    for(const q of ns)if(q>=0&&!labels[q]&&mask[q]>=.5){labels[q]=label;queue[tail++]=q;}
   }
   const cx=sx/tail,cy=sy/tail,dist=Math.hypot(cx-SIZE/2,cy-SIZE*.53)/SIZE;
   components.push({label,area:tail,minX,minY,maxX,maxY,cx,cy,border,score:tail/(1+dist*4)*(border?.25:1)});
  }
  components.sort((a,b)=>b.score-a.score);
  const main=components[0];
  if(!main||main.area<180)throw new Error('没有识别到完整主体，请选择鞋子更清楚、背景较浅的照片。');
  const kept=components.filter(c=>c===main||(!c.border&&c.area>main.area*.12&&Math.hypot(c.cx-main.cx,c.cy-main.cy)<SIZE*.45));
  const ids=new Set(kept.map(c=>c.label));
  const minX=Math.min(...kept.map(c=>c.minX)),minY=Math.min(...kept.map(c=>c.minY)),maxX=Math.max(...kept.map(c=>c.maxX)),maxY=Math.max(...kept.map(c=>c.maxY));
  const keep=new Uint8Array(n);
  for(let i=0;i<n;i++)if(ids.has(labels[i]))keep[i]=1;
  // Retain a narrow soft-alpha band around selected components.
  const allowed=keep.slice();
  for(let y=2;y<SIZE-2;y++)for(let x=2;x<SIZE-2;x++){const i=y*SIZE+x;if(keep[i])continue;for(let dy=-2;dy<=2&&!allowed[i];dy++)for(let dx=-2;dx<=2;dx++)if(keep[i+dy*SIZE+dx]){allowed[i]=1;break;}}
  for(let i=0;i<n;i++)if(!allowed[i])mask[i]=0;
  return {minX,minY,maxX,maxY,border:kept.some(c=>c.border)};
 }
 // Mark pixels within r of the cleaned first-pass shoe, so the refined pass cannot pick up distant objects.
 function nearMask(mask,r){
  const n=SIZE*SIZE,h=new Uint8Array(n),v=new Uint8Array(n),w=2*r+1;
  for(let y=0;y<SIZE;y++){const o=y*SIZE;let c=0;for(let x=0;x<SIZE+r;x++){if(x<SIZE&&mask[o+x]>=.5)c++;if(x-w>=0&&mask[o+x-w]>=.5)c--;const t=x-r;if(t>=0)h[o+t]=c>0?1:0;}}
  for(let x=0;x<SIZE;x++){let c=0;for(let y=0;y<SIZE+r;y++){if(y<SIZE&&h[y*SIZE+x])c++;if(y-w>=0&&h[(y-w)*SIZE+x])c--;const t=y-r;if(t>=0)v[t*SIZE+x]=c>0?1:0;}}
  return v;
 }
 function sample(mask,xx,yy){
  xx=Math.max(0,Math.min(SIZE-1,xx));yy=Math.max(0,Math.min(SIZE-1,yy));
  const ix=Math.floor(xx),iy=Math.floor(yy),ix1=Math.min(SIZE-1,ix+1),iy1=Math.min(SIZE-1,iy+1),tx=xx-ix,ty=yy-iy;
  return (mask[iy*SIZE+ix]*(1-tx)+mask[iy*SIZE+ix1]*tx)*(1-ty)+(mask[iy1*SIZE+ix]*(1-tx)+mask[iy1*SIZE+ix1]*tx)*ty;
 }
 // Second pass: run the model again on the cropped shoe so its edges get the full 1024 px of model resolution.
 async function refine(bmp,x0,y0,cw,ch){
  const canvas=new OffscreenCanvas(SIZE,SIZE),ctx=canvas.getContext('2d',{willReadFrequently:true});
  ctx.imageSmoothingQuality='high';ctx.fillStyle='#fff';ctx.fillRect(0,0,SIZE,SIZE);ctx.drawImage(bmp,x0,y0,cw,ch,0,0,SIZE,SIZE);
  const mask=await identify(ctx.getImageData(0,0,SIZE,SIZE).data,()=>{});
  mainComponents(mask);
  return mask;
 }
 async function preparePixels(file,onProgress=()=>{}){
  if(!/\.(jpe?g|png|webp)$/i.test(file.name))throw new Error('请使用 JPG、PNG 或 WebP 照片。');
  const bmp=await createImageBitmap(file,{imageOrientation:'from-image'});
  try{
   const ow=bmp.width,oh=bmp.height;
   if(ow*oh>50000000)throw new Error('照片尺寸过大，请使用 5000 万像素以内的图片。');
   const modelCanvas=new OffscreenCanvas(SIZE,SIZE),mctx=modelCanvas.getContext('2d',{willReadFrequently:true});
   mctx.fillStyle='#fff';mctx.fillRect(0,0,SIZE,SIZE);mctx.drawImage(bmp,0,0,SIZE,SIZE);
   const mask=await identify(mctx.getImageData(0,0,SIZE,SIZE).data,onProgress);
   const box=mainComponents(mask);const bw=box.maxX-box.minX+1,bh=box.maxY-box.minY+1;
   const x0=Math.max(0,Math.floor((box.minX-bw*.4)*ow/SIZE)),x1=Math.min(ow,Math.ceil((box.maxX+bw*.4)*ow/SIZE));
   const y0=Math.max(0,Math.floor((box.minY-bh*.22)*oh/SIZE)),y1=Math.min(oh,Math.ceil((box.maxY+bh*.45)*oh/SIZE));
   const cw=x1-x0,ch=y1-y0,f=Math.min(1,2304/Math.max(cw,ch)),width=Math.max(1,Math.round(cw*f)),height=Math.max(1,Math.round(ch*f));
   // The refined pass only helps when the crop is noticeably smaller than the photo; a shoe that already fills the frame gains little.
   let fine=null;
   if(Math.max(ow/cw,oh/ch)>=1.35){onProgress('正在精修鞋子边缘…');try{fine=await refine(bmp,x0,y0,cw,ch);}catch{fine=null;}}
   onProgress('正在保留鞋面细节并提取原图阴影…');
   const canvas=new OffscreenCanvas(width,height),ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.imageSmoothingQuality='high';ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);ctx.drawImage(bmp,x0,y0,cw,ch,0,0,width,height);
   const rgba=ctx.getImageData(0,0,width,height).data,coarseMask=new Float32Array(width*height),fineMask=fine?new Float32Array(width*height):null;
   const near=fine?nearMask(mask,12):null;let coarseArea=0,fineArea=0;
   for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=y*width+x,xx=((x+.5)/width*cw+x0)/ow*SIZE-.5,yy=((y+.5)/height*ch+y0)/oh*SIZE-.5;
    const c=sample(mask,xx,yy);coarseMask[i]=c;if(c>=.5)coarseArea++;
    if(fine){const nx=Math.max(0,Math.min(SIZE-1,Math.round(xx))),ny=Math.max(0,Math.min(SIZE-1,Math.round(yy)));
     const f=near[ny*SIZE+nx]?sample(fine,(x+.5)/width*SIZE-.5,(y+.5)/height*SIZE-.5):0;fineMask[i]=f;if(f>=.5)fineArea++;}
   }
   // Keep the refined mask only when it agrees with the first pass on the overall shoe size.
   const ratio=coarseArea?fineArea/coarseArea:0,useFine=fine&&ratio>.8&&ratio<1.25;
   return {rgba,width,height,mask:useFine?fineMask:coarseMask,refined:!!useFine,originalWidth:ow,originalHeight:oh,sourceBox:[x0,y0,cw,ch],clipped:box.border};
  }finally{bmp.close();}
 }
 globalThis.GrayInference={preparePixels};
})();
