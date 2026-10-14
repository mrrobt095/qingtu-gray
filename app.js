(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const DEFAULTS = Object.freeze({width:900,height:1200,background:'#E6E6E6',scale:0.86,rotation:0,shadow:1,shadowMode:'contact',shadowRange:1,shadowSoftness:.35,format:'jpeg',quality:0.98,offsetX:0,offsetY:-0.01875,exposure:0,contrast:0,temperature:0,saturation:0,logoEnabled:true,logoId:'default',logoX:30/900,logoY:27/1200,logoWidth:194/900,logoOpacity:1});
  // Up to 60 photos per batch; only the 12 most recently used keep their full working data in memory (about 50 MB each).
  // The rest are rebuilt on demand from the recognition cache in a few seconds.
  const LIMITS = {files:60,fileBytes:30*1024*1024,prepared:12};
  let items=[], serial=0, selectedId=null, busy=false, activeItem=null, archiveBusy=false, view='result', currentFormat='jpeg';
  let defaults={...DEFAULTS}, stage='', dropDepth=0, toastTimer, settingsTimer, pendingChange=null;
  let currentLogoId='default', assetsReady=false, assetBusy=false, templates=[], savedLogos=[], editorReady=false, editorResult=null, editorVisible=false, editorDragging=false;
  let brushMode='move', brushSize=100, brushHardness=0, brushOpacity=25, editorBrushKey='', editorOwnerId=null, interactionOwnerId=null;
  let currentPanel='layout',currentTool='move',comparing=false,previewEpoch=0,previewJob=null,previewRunning=false;
  let psdBusy=false,psdAbort=null;
  const SHADOW_EDIT_LIMITS={strokes:200,points:20000};
  const numberFields={'shadow-range':['shadowRange',1,.3,2],'shadow-softness':['shadowSoftness',100,0,100],'rotation-number':['rotation',1,-180,180],'offset-x':['offsetX',100,-50,50],'offset-y':['offsetY',100,-50,50],'exposure':['exposure',1,-1.5,1.5],'contrast':['contrast',1,-50,50],'temperature':['temperature',1,-50,50],'saturation':['saturation',1,-50,50],'logo-x':['logoX',100,0,100],'logo-y':['logoY',100,0,100],'logo-width':['logoWidth',100,2,80],'logo-opacity':['logoOpacity',100,0,100]};
  const selected=()=>items.find(item=>item.id===selectedId);
  const bytes=n=>n<1024*1024?(n/1024).toFixed(0)+' KB':(n/1024/1024).toFixed(1)+' MB';
  const isWorking=item=>item&&(item.status==='pending'||item.status==='processing');
  function say(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4500);}
  function banner(message){$('banner').textContent=message;$('banner').hidden=!message;}
  function snapshot(item){return {settings:{...item.settings},shadowEdits:item.shadowEdits.slice()};}
  function remember(item){item.past||=[];item.future=[];item.past.push(snapshot(item));if(item.past.length>30)item.past.shift();if(item.status==='done'&&item.result){item.compareResult=item.result;item.compareSettings={...item.settings};}}
  function markPending(item){item.version++;if(!item.preError){item.status=item===activeItem?'processing':'pending';item.error=null;}persistEdits(item);}
  function historyStep(redo=false){const item=selected();if(!item||item.status!=='done'||editorDragging||pendingChange||assetBusy||archiveBusy||comparing)return;const from=redo?item.future:item.past,to=redo?item.past:item.future;if(!from?.length)return;to.push(snapshot(item));item.compareResult=item.result;item.compareSettings={...item.settings};const saved=from.pop();item.settings={...saved.settings};item.shadowEdits=saved.shadowEdits.slice();markPending(item);fillSettings(item.settings);outputNames();render();run();}
  function setPanel(name){if(!['layout','shadow','tone','logo','export','templates'].includes(name))return;currentPanel=name;document.querySelectorAll('[data-panel]').forEach(button=>button.setAttribute('aria-pressed',button.dataset.panel===name));document.querySelectorAll('[data-panel-content]').forEach(panel=>panel.hidden=panel.dataset.panelContent!==name);if(name!=='shadow'&&brushMode!=='move')setBrushMode('move');}
  function setTool(name){if(editorDragging||comparing)return;currentTool=name;if(name==='shadow'){setPanel('shadow');setBrushMode('erase');document.querySelector('.shadow-brush-panel')?.scrollIntoView({block:'nearest'});}else{setBrushMode('move');setPanel('layout');if(name==='rotate'){$('rotation-number').focus({preventScroll:true});$('rotation-number').scrollIntoView({block:'nearest'});}}document.querySelectorAll('[data-tool]').forEach(button=>button.setAttribute('aria-pressed',button.dataset.tool===name));}
  function stopCompare(){if(!comparing)return;comparing=false;const item=selected();$('compare-hold')?.setAttribute('aria-pressed','false');if(editorReady&&item?.result){GrayEditor.show(item.result,{...item.settings,_photoId:item.id});editorResult=item.result;editorVisible=true;}renderPreview();updateControls();}
  function startCompare(){const item=selected();if(comparing||!item?.compareResult||item.status!=='done'||editorDragging||pendingChange||view!=='result'||assetBusy||archiveBusy)return;comparing=true;GrayEditor.show(item.compareResult,{...item.compareSettings,_photoId:item.id});GrayEditor.setDisabled(true);$('compare-hold').setAttribute('aria-pressed','true');$('preview-tag').textContent='上次修改前';updateControls();}
  function queueShadowPreview(stroke){const epoch=++previewEpoch;if(!stroke){previewJob=null;GrayEditor.showPreview?.(null);return;}const item=selected();if(!item?.prepared||item.id!==(interactionOwnerId??editorOwnerId)||!GrayEngine.preview)return;previewJob={item,epoch,version:item.version,stroke};pumpShadowPreview();}
  async function pumpShadowPreview(){if(previewRunning)return;previewRunning=true;try{while(previewJob){const job=previewJob;previewJob=null;try{const result=await GrayEngine.preview(job.item.prepared,{...job.item.settings,shadowEdits:[...job.item.shadowEdits,job.stroke]});if(previewEpoch===job.epoch&&selected()===job.item&&job.item.version===job.version&&editorDragging)GrayEditor.showPreview?.(result);}catch{if(previewEpoch===job.epoch)GrayEditor.showPreview?.(null);}}}finally{previewRunning=false;}}
  function releasePrepared(prepared){if(prepared&&window.GrayEngine?.dispose)window.GrayEngine.dispose(prepared);}
  // Batch persistence: the photo is written once when added; settings and strokes are saved shortly after each change.
  let sessionReady=false;const saveTimers=new Map();
  function editsRecord(item){return {settings:{...item.settings},shadowEdits:item.shadowEdits.map(stroke=>({...stroke,points:stroke.points.map(point=>[...point])}))};}
  function persistNew(item){if(sessionReady&&!item.preError)GraySession.savePhoto({uid:item.uid,order:item.id,path:item.path,name:item.file.name,file:item.file},editsRecord(item));}
  function flushEdits(item){clearTimeout(saveTimers.get(item.uid));saveTimers.delete(item.uid);if(sessionReady&&items.includes(item)&&!item.preError)GraySession.saveEdits(item.uid,editsRecord(item));}
  function persistEdits(item){if(!sessionReady||!item?.uid)return;clearTimeout(saveTimers.get(item.uid));saveTimers.set(item.uid,setTimeout(()=>flushEdits(item),250));}
  function persistMeta(){if(sessionReady)GraySession.saveMeta({selected:selected()?.uid||null,defaults:{...defaults}});}
  // Small thumbnails of the original photos, so the list shows every photo before it is processed. Made one at a time.
  let thumbQueue=Promise.resolve();
  function queueThumb(item){
    if(item.preError||item.thumbUrl)return;
    thumbQueue=thumbQueue.then(async()=>{
      if(!items.includes(item)||item.thumbUrl)return;
      try{const bmp=await createImageBitmap(item.file,{imageOrientation:'from-image',resizeHeight:240,resizeQuality:'medium'});const c=new OffscreenCanvas(bmp.width,bmp.height);c.getContext('2d').drawImage(bmp,0,0);bmp.close();const blob=await c.convertToBlob({type:'image/jpeg',quality:.82});if(!items.includes(item))return;item.thumbUrl=URL.createObjectURL(blob);if(!item.url)renderList();}catch{}
    });
  }
  // Review filter: photos that finished with a warning or failed.
  let reviewOnly=false;
  const needsReview=item=>item.status==='error'||(item.status==='done'&&item.warnings?.length>0);
  // Time estimate: average duration of recent photos that needed recognition (cached or not).
  const prepareTimes=[];
  function estimate(){
    if(!prepareTimes.length)return '';
    const avg=prepareTimes.reduce((a,b)=>a+b,0)/prepareTimes.length,left=items.filter(x=>isWorking(x)&&!x.prepared).length*avg/1000;
    if(left<5)return '';return left<60?'约 '+Math.max(5,Math.round(left/5)*5)+' 秒':'约 '+Math.ceil(left/60)+' 分钟';
  }
  // Free the working data of photos that are finished and not on screen, oldest first, once more than LIMITS.prepared hold it.
  function evictPrepared(){const holding=items.filter(x=>x.prepared);if(holding.length<=LIMITS.prepared)return;const spare=holding.filter(x=>x.status==='done'&&x!==activeItem&&x.id!==selectedId).sort((a,b)=>(a.usedAt||0)-(b.usedAt||0));for(const x of spare.slice(0,holding.length-LIMITS.prepared)){releasePrepared(x.prepared);x.prepared=null;}}
  function release(item){if(item.url)URL.revokeObjectURL(item.url);if(item.thumbUrl)URL.revokeObjectURL(item.thumbUrl);item.thumbUrl=null;if(item.originalUrl)URL.revokeObjectURL(item.originalUrl);releasePrepared(item.prepared);item.prepared=null;item.result=null;item.compareResult=null;item.past=[];item.future=[];item.url=null;item.originalUrl=null;}
  function readSettings(){const custom=$('size-preset').value==='custom';const size=custom?[$('output-width').value,$('output-height').value]:$('size-preset').value.split('x');const s={width:Number(size[0]),height:Number(size[1]),background:$('background-hex').value.toUpperCase(),scale:Number($('scale').value)/100,shadow:Number($('shadow').value)/100,shadowMode:$('shadow-mode').value,format:currentFormat,quality:0.98,logoEnabled:$('logo-enabled').checked,logoId:currentLogoId};for(const [id,[key,factor]]of Object.entries(numberFields))s[key]=$(id).value===''?NaN:Number($(id).value)/factor;return s;}
  function validSettings(s){return Number.isInteger(s.width)&&Number.isInteger(s.height)&&s.width>=300&&s.height>=300&&s.width<=4000&&s.height<=4000&&/^#[0-9A-F]{6}$/i.test(s.background)&&Number.isFinite(s.scale)&&s.scale>=0.2&&s.scale<=0.96&&Number.isFinite(s.shadow)&&s.shadow>=0&&s.shadow<=1.6&&['contact','original','none'].includes(s.shadowMode)&&Object.values(numberFields).every(([key,factor,min,max])=>Number.isFinite(s[key])&&s[key]*factor>=min-0.000001&&s[key]*factor<=max+0.000001);}
  function signed(n){return(n>0?'+':'')+Number(n.toFixed(2));}
  function updateLabels(s){$('rotation').value=Math.max(-45,Math.min(45,s.rotation));$('shadow-softness-value').textContent=Math.round(s.shadowSoftness*100)+'%';$('shadow-range-value').textContent=Number(s.shadowRange.toFixed(1))+' 倍';$('shadow-summary').textContent={contact:'落地阴影',original:'原图阴影',none:'无阴影'}[s.shadowMode]||'落地阴影';$('scale-value').textContent=Number((s.scale*100).toFixed(1))+'%';$('shadow-value').textContent=Math.round(s.shadow*100)+'%';for(const key of ['exposure','contrast','temperature','saturation'])$(key+'-value').textContent=signed(s[key]);$('logo-width-value').textContent=Number((s.logoWidth*100).toFixed(1))+'%';$('logo-opacity-value').textContent=Math.round(s.logoOpacity*100)+'%';const name=window.GrayAssets?.getLogoInfo?.(s.logoId)?.name||savedLogos.find(x=>x.id===s.logoId)?.name||'默认 Logo';$('logo-name').textContent=name;$('logo-name').title=name;$('logo-summary').textContent=s.logoEnabled?'已启用':'已隐藏';$('logo-select').value=s.logoId;document.querySelectorAll('[data-layout]').forEach(b=>{const p=layoutSettings(b.dataset.layout);b.setAttribute('aria-pressed',Math.abs(s.scale-p.scale)<0.0001&&Math.abs(s.offsetX-p.offsetX)<0.0001&&Math.abs(s.offsetY-p.offsetY)<0.0001);});}
  function fillSettings(settings){const s={...DEFAULTS,...settings};const preset=s.width+'x'+s.height;const supported=Array.from($('size-preset').options).some(x=>x.value===preset);$('size-preset').value=supported?preset:'custom';$('custom-size').hidden=supported;$('output-width').value=s.width;$('output-height').value=s.height;$('background-hex').value=s.background;$('background-color').value=s.background;$('scale').value=s.scale*100;$('shadow').value=s.shadow*100;$('shadow-mode').value=s.shadowMode;for(const[id,[key,factor]]of Object.entries(numberFields))$(id).value=Number((s[key]*factor).toFixed($(id).type==='range'?8:4));$('logo-enabled').checked=s.logoEnabled;currentLogoId=s.logoId;currentFormat=s.format;updateLabels(s);document.querySelectorAll('[data-format]').forEach(button=>button.setAttribute('aria-pressed',button.dataset.format===s.format));for(const id of ['output-width','output-height','background-hex',...Object.keys(numberFields)])$(id).removeAttribute('aria-invalid');}
  function layoutSettings(name){return {scale:name==='airy'?0.76:0.86,offsetX:0,offsetY:name==='reference'?-0.01875:0};}
  function changeFields(delta){if(archiveBusy)return;const next={...readSettings(),...delta};if(!validSettings(next)){say('请先检查右侧设置，再继续调整。');return;}fillSettings(next);settingsChanged();}
  function updateBrushControls(){
    const item=selected(),mode=readSettings().shadowMode,available=!!(editorReady&&item?.result?.patchCanvas&&view==='result'&&mode!=='none');
    const locked=!available||item?.status!=='done'||archiveBusy||assetBusy||editorDragging||comparing||!!pendingChange||!validSettings(readSettings());
    document.querySelectorAll('[data-brush]').forEach(button=>{button.disabled=locked;button.setAttribute('aria-pressed',button.dataset.brush===brushMode);});
    for(const [id,value,suffix]of [['shadow-brush-size',brushSize,' px'],['shadow-brush-hardness',brushHardness,'%'],['shadow-brush-opacity',brushOpacity,'%']]){$(id).disabled=locked||brushMode==='move'||comparing;$(id+'-value').textContent=value+suffix;}
    const count=item?.shadowEdits?.length||0;$('shadow-edits-count').textContent=count?'当前照片已编辑 '+count+' 笔':'只修改阴影，鞋子纹理保留';
    $('shadow-undo').disabled=locked||!count;$('shadow-clear').disabled=locked||!count;
    $('shadow').disabled=archiveBusy||assetBusy||editorDragging||comparing||mode==='none';$('shadow-range').disabled=archiveBusy||assetBusy||editorDragging||comparing||mode!=='contact';$('shadow-softness').disabled=$('shadow-range').disabled;
    if(editorReady&&!editorDragging){const effectiveMode=available?brushMode:'move',key=[effectiveMode,brushSize,brushHardness,brushOpacity].join('|');if(key!==editorBrushKey){GrayEditor.setBrush?.({mode:effectiveMode,size:brushSize,hardness:brushHardness/100,opacity:brushOpacity/100});editorBrushKey=key;}}
  }
  function setBrushMode(mode){brushMode=mode;if(mode!=='move'){currentTool='shadow';setPanel('shadow');}else if(currentTool==='shadow')currentTool='move';updateBrushControls();document.querySelectorAll('[data-tool]').forEach(button=>button.setAttribute('aria-pressed',button.dataset.tool===currentTool));}
  function changeShadowEdits(next,item=selected()){if(!item||!items.includes(item)||archiveBusy||assetBusy||comparing)return;remember(item);item.shadowEdits=next;markPending(item);render();run();}
  function addShadowStroke(stroke){
    const item=selected();if(!item||item.id!==(interactionOwnerId??editorOwnerId)||item.status!=='done'||pendingChange||view!=='result'||item.settings.shadowMode==='none'||archiveBusy||assetBusy)return;
    if(!stroke||!['erase','restore'].includes(stroke.mode)||!Number.isFinite(stroke.radius)||stroke.radius<=0||stroke.radius>1||!Array.isArray(stroke.points)||!stroke.points.length||!stroke.points.every(point=>Array.isArray(point)&&point.length===2&&point.every(n=>Number.isFinite(n)&&n>=0&&n<=1))){say('这笔阴影调整未能保存，请重试。');return;}
    const previous=item.shadowEdits||[],pointCount=previous.reduce((sum,value)=>sum+value.points.length,0)+stroke.points.length;
    if(previous.length>=SHADOW_EDIT_LIMITS.strokes||pointCount>SHADOW_EDIT_LIMITS.points){say('这张照片的阴影编辑已达上限，可撤销或清空后重新调整。');return;}
    const hardness=stroke.hardness??brushHardness/100,opacity=stroke.opacity??brushOpacity/100;if(![hardness,opacity].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1)){say('这笔阴影调整参数无效。');return;}
    const copy={mode:stroke.mode,radius:stroke.radius,hardness,opacity,points:stroke.points.map(point=>[...point])};queueShadowPreview(null);changeShadowEdits([...previous,copy],item);
  }
  function updateControls(){
    const item=selected(),locked=archiveBusy||assetBusy||editorDragging||comparing;
    document.querySelectorAll('.settings input,.settings select,.settings button,#choose,#choose-folder').forEach(x=>x.disabled=locked);
    $('choose').disabled=locked||!window.PhotoCore||!window.GrayEngine;$('choose-folder').disabled=$('choose').disabled;
    $('apply-all').disabled=locked||items.length<2||!validSettings(readSettings());$('download-all').disabled=locked||items.some(isWorking)||!items.some(x=>x.status==='done')||!!pendingChange||!validSettings(readSettings());
    $('download-psd').disabled=locked||!items.length||items.some(isWorking)||!!pendingChange||!validSettings(readSettings());
    for(const id of ['logo-upload','logo-default','logo-select','template-select','template-name','template-save'])$(id).disabled=locked||!assetsReady;
    $('template-delete').disabled=locked||!assetsReady||!$('template-select').value;$('logo-delete').disabled=locked||!assetsReady||currentLogoId==='default';
    for(const id of ['logo-width','logo-opacity','logo-x','logo-y'])$(id).disabled=locked||!$('logo-enabled').checked;document.querySelectorAll('[data-logo-corner]').forEach(x=>x.disabled=locked||!$('logo-enabled').checked);
    const editable=!!(item?.result&&item.status==='done'&&view==='result'&&!pendingChange);
    $('history-undo').disabled=locked||!editable||!item.past?.length;$('history-redo').disabled=locked||!editable||!item.future?.length;
    $('compare-hold').disabled=!comparing&&(locked||!editable||!item.compareResult);
    $('zoom-select').disabled=locked||!item?.result||view!=='result';$('split-compare').disabled=locked||!editorReady||(!splitOn&&!(editable&&item?.sourceInfo));$('split-compare').setAttribute('aria-pressed',splitOn);document.querySelectorAll('[data-tool]').forEach(x=>{x.disabled=locked||!editable||splitOn;x.setAttribute('aria-pressed',x.dataset.tool===currentTool);});
    document.querySelectorAll('[data-panel]').forEach(x=>x.disabled=locked);
    $('download-one').disabled=locked||!editable||!validSettings(readSettings());
    $('clear').disabled=locked||!items.length;
    document.querySelectorAll('.file-card button').forEach(x=>x.disabled=locked);
    for(const id of ['select-shoe','select-logo','deselect-editor'])$(id).disabled=locked||!editable||(id==='select-logo'&&!item?.settings.logoEnabled);
    document.querySelectorAll('[data-view]').forEach(x=>x.disabled=locked||!item||(x.dataset.view==='result'&&!item.url));
    $('export-summary').textContent=readSettings().width+' × '+readSettings().height+' · '+(currentFormat==='png'?'PNG 无损':'JPG 高质量')+' · '+items.filter(x=>x.status==='done').length+'/'+items.length+' 已完成';
    if($('psd-dialog').open&&!psdBusy)refreshPsdDialog();
    updateBrushControls();
  }
  async function refreshAssets(templateId){[templates,savedLogos]=await Promise.all([GrayAssets.listTemplates(),GrayAssets.listLogos()]);const chosen=templateId===undefined?$('template-select').value:templateId;$('template-select').replaceChildren(new Option('选择模板…',''),...templates.map(x=>new Option(x.name,x.id)));$('template-select').value=chosen||'';$('logo-select').replaceChildren(...savedLogos.map(x=>new Option(x.name,x.id)));$('logo-select').value=currentLogoId;updateLabels(readSettings());updateControls();}
  async function assetAction(action){if(assetBusy||archiveBusy||editorDragging||!assetsReady)return;commitChange();assetBusy=true;render();try{await action();}catch(error){say(error?.message||'操作未完成，请重试。');}finally{assetBusy=false;render();}}
  function outputNames(){const used=new Set();for(const item of items){item.outputName=PhotoCore.uniqueName(item.path.replace(/\.[^/.]+$/,'')+'_灰底.'+(item.settings.format==='jpeg'?'jpg':'png'),used);}}
  function renderPreview(){const item=selected();$('preview-empty').hidden=!!item;const available=item&&(view==='original'||item.url);const img=$('preview-image');img.hidden=!available;
    if(available){if(view==='original'&&!item.originalUrl)item.originalUrl=URL.createObjectURL(item.file);const url=view==='original'?item.originalUrl:item.url;if(img.getAttribute('src')!==url)img.src=url;img.alt=item.file.name+(view==='original'?' 原图':' 灰底处理结果');}else img.removeAttribute('src');
    $('preview-tag').hidden=!available;$('preview-tag').textContent=view==='original'?'原图 · 完整构图':comparing?'上次修改前':'灰底效果';
    $('preview-name').textContent=item?item.path:'还未选择照片';$('preview-name').title=item?.path||'';
    let info='处理后的照片会显示在这里';if(item){if(view==='original'){const p=item.prepared;info=p?('原图 '+(p.originalWidth||p.width)+' × '+(p.originalHeight||p.height)+' · '+bytes(item.file.size)):'原图 · '+bytes(item.file.size);}else info=item.result?item.result.width+' × '+item.result.height+' · '+item.settings.format.toUpperCase().replace('JPEG','JPG')+' · '+bytes(item.result.blob.size):item.status==='error'?'这张照片未完成，可在下方重试':'等待生成灰底效果';}
    $('preview-info').textContent=info;$('preview-working').hidden=!isWorking(item);$('preview-working-text').textContent=item?.status==='processing'?(item.stage||'正在处理…'):'等待处理…';
    const warnings=item?.status==='error'?[item.error]:item?.warnings||[];$('preview-warning').hidden=!warnings.length;$('preview-warning').textContent=warnings.length?(item.status==='error'?'未完成：':'建议检查：')+warnings.join('；'):'';
    $('download-one').disabled=!item?.result||item.status!=='done'||archiveBusy||editorDragging||assetBusy||comparing||!!pendingChange||!validSettings(readSettings());
    const editable=!!(editorReady&&item?.result?.patchCanvas&&view==='result');$('editor-toolbar').hidden=!editable;
    if(editable){img.hidden=true;$('editor-canvas').hidden=false;if(editorResult!==item.result||!editorVisible){editorOwnerId=item.id;Promise.resolve(GrayEditor.show(item.result,{...item.settings,_photoId:item.id})).catch(()=>{editorReady=false;GrayEditor.hide();renderPreview();say('拖动画布未能显示，可继续通过右侧设置调整并下载。');});editorResult=item.result;editorVisible=true;}if(!editorDragging)GrayEditor.setDisabled(archiveBusy||assetBusy||comparing||splitOn||item.status!=='done'||!!pendingChange||!validSettings(readSettings()));}else if(editorReady){editorOwnerId=null;GrayEditor.hide();editorVisible=false;$('editor-canvas').hidden=true;}
    $('select-shoe').disabled=!editable||item?.status!=='done'||archiveBusy||assetBusy||editorDragging||comparing||!!pendingChange;$('select-logo').disabled=$('select-shoe').disabled||!item?.settings.logoEnabled;$('deselect-editor').disabled=$('select-shoe').disabled;
    document.querySelectorAll('[data-view]').forEach(button=>{button.disabled=!item||editorDragging||assetBusy||archiveBusy||comparing||(button.dataset.view==='result'&&!item.url);button.setAttribute('aria-pressed',button.dataset.view===view);});
    $('settings-scope').textContent=item?'正在编辑第 '+(items.indexOf(item)+1)+' / '+items.length+' 张':'添加照片后开始编辑';updateBrushControls();
  }
  function renderList(){const list=$('file-list');const focused=document.activeElement?.dataset;const focusId=focused?.id, focusAction=focused?.action;list.replaceChildren();
    for(const item of reviewOnly?items.filter(needsReview):items){const card=document.createElement('div');card.className='file-card'+(item.id===selectedId?' selected':'');card.setAttribute('role','listitem');
      const button=document.createElement('button');button.type='button';button.className='file-select';button.dataset.action='select';button.dataset.id=item.id;button.setAttribute('aria-label','预览 '+item.file.name);button.setAttribute('aria-pressed',item.id===selectedId);button.disabled=archiveBusy||editorDragging||assetBusy;
      const src=item.url||item.thumbUrl,thumb=document.createElement(src?'img':'span');thumb.className='file-thumb'+(src?(item.url?'':' is-original'):' thumb-placeholder');if(src){thumb.src=src;thumb.alt='';thumb.loading='lazy';}else thumb.textContent=item.status==='error'?'!':'·';button.append(thumb);
      const copy=document.createElement('span');copy.className='file-copy';const name=document.createElement('span');name.className='file-name';name.textContent=item.file.name;name.title=item.path;copy.append(name);
      const state=document.createElement('span');state.className='file-state '+(item.status==='done'&&item.warnings?.length?'warning':item.status);state.textContent=item.status==='done'?(item.warnings?.length?'建议检查':'已完成'):item.status==='error'?'未完成':item.status==='processing'?'正在处理':'等待处理';copy.append(state);button.append(copy);card.append(button);
      const remove=document.createElement('button');remove.type='button';remove.className='remove-button';remove.textContent='×';remove.dataset.id=item.id;remove.dataset.action='remove';remove.setAttribute('aria-label','移除 '+item.file.name);remove.disabled=archiveBusy||editorDragging||assetBusy;card.append(remove);
      if(item.status==='error'&&!item.preError){const retry=document.createElement('button');retry.type='button';retry.className='retry-button';retry.textContent='重试';retry.dataset.id=item.id;retry.dataset.action='retry';retry.setAttribute('aria-label','重新处理 '+item.file.name);retry.disabled=archiveBusy||editorDragging||assetBusy;card.append(retry);}list.append(card);
    }
    if(focusId&&focusAction){const target=list.querySelector('[data-id="'+Number(focusId)+'"][data-action="'+focusAction+'"]');target?.focus({preventScroll:true});}
  }
  function render(){document.body.classList.toggle('has-photos',items.length>0);const done=items.filter(x=>x.status==='done'),errors=items.filter(x=>x.status==='error');const pending=items.some(isWorking);$('counter').textContent=items.length+' / '+LIMITS.files;$('list-empty').hidden=!!items.length;$('clear').disabled=!items.length||archiveBusy||editorDragging||assetBusy;$('apply-all').disabled=!items.length||archiveBusy||!validSettings(readSettings());
    $('download-all').disabled=!done.length||pending||archiveBusy||editorDragging||assetBusy||comparing||!!pendingChange||!validSettings(readSettings());$('download-label').textContent=archiveBusy?'正在打包…':done.length?'全部下载 ZIP · '+done.length+' 张':'全部下载 ZIP';
    $('statusline').textContent=!items.length?'添加照片即可开始；首次处理需要加载本地识别模型。':pending?'已完成 '+done.length+' / '+items.length+' 张'+(stage?' · '+stage:' · 等待处理'):errors.length?done.length+' 张完成，'+errors.length+' 张未完成；可逐张重试。':done.length+' 张已完成'+(done.some(x=>x.warnings?.length)?' · 下载前请检查标记的照片。':' · 检查效果后，即可下载。');
    const progress=items.length?Math.round((done.length+errors.length)/items.length*100):0;$('progress-fill').style.width=progress+'%';$('progress').setAttribute('aria-valuenow',progress);
    const working=items.filter(isWorking).length,eta=estimate();$('batch-progress').hidden=!working;
    if(working){$('batch-progress-text').textContent='正在处理 · 已完成 '+done.length+' / '+items.length+(eta?' · 还需'+eta:'');$('batch-bar-fill').style.width=progress+'%';}
    const reviewCount=items.filter(needsReview).length;if(!reviewCount)reviewOnly=false;$('review-filter').hidden=!reviewCount;$('review-filter').setAttribute('aria-pressed',reviewOnly);$('review-count').textContent=reviewCount+' 张';
    renderPreview();renderList();updateControls();
  }
  // Let the page update between photos. Unlike setTimeout, a MessageChannel hand-off is not throttled when the window is in
  // the background, so a large batch keeps going at full speed while the user works in another window.
  function yieldTask(){return new Promise(resolve=>{const channel=new MessageChannel();channel.port1.onmessage=()=>{channel.port1.close();resolve();};channel.port2.postMessage(0);});}
  // Split comparison: a downscaled copy (at most 3000 px) of the original photo, drawn by the editor into the output frame.
  let splitOn=false,splitBitmap=null;
  async function setSplitMode(on){
    const item=selected();
    if(!on||!item){if(!splitOn&&!splitBitmap)return;splitOn=false;GrayEditor.setSplit?.(null);splitBitmap?.close();splitBitmap=null;renderPreview();updateControls();return;}
    const info=item.sourceInfo;if(splitOn||item.status!=='done'||!item.result||view!=='result'||!editorReady||!info?.box||!(info.width>0)||!(info.ow>0))return;
    splitOn=true;renderPreview();updateControls();
    try{
      const r=Math.min(1,3000/Math.max(info.ow,info.oh));
      const bmp=await createImageBitmap(item.file,{imageOrientation:'from-image',resizeWidth:Math.max(1,Math.round(info.ow*r)),resizeHeight:Math.max(1,Math.round(info.oh*r)),resizeQuality:'high'});
      if(!splitOn||selected()!==item){bmp.close();return;}
      splitBitmap?.close();splitBitmap=bmp;GrayEditor.setSplit({image:bmp,r:bmp.width/info.ow,k:info.box[2]/info.width,x0:info.box[0],y0:info.box[1]});
    }catch{splitOn=false;say('原图未能载入，无法对比。');}
    renderPreview();updateControls();
  }
  async function run(){if(busy||archiveBusy)return;busy=true;try{while(true){const item=items.find(x=>x.status==='pending');if(!item)break;activeItem=item;let renderVersion=null;const started=performance.now(),needsPrepare=!item.prepared;item.status='processing';item.stage=item.prepared?'正在调整画面…':'正在准备照片…';stage=item.stage;render();
      try{if(!window.GrayEngine)throw new Error('本地处理组件未能加载，请重新打开工具。');if(!item.prepared){const prepared=await GrayEngine.prepare(item.file,message=>{if(!items.includes(item))return;item.stage=String(message);stage=item.stage;$('statusline').textContent='已完成 '+items.filter(x=>x.status==='done').length+' / '+items.length+' 张 · '+stage;renderPreview();});if(!items.includes(item)){releasePrepared(prepared);continue;}item.prepared=prepared;item.sourceInfo={box:prepared.sourceBox,width:prepared.width,ow:prepared.originalWidth,oh:prepared.originalHeight};}
        if(!items.includes(item))continue;item.status='processing';item.stage='正在合成灰底画面…';stage=item.stage;renderPreview();renderVersion=item.version;const options={...item.settings,shadowEdits:item.shadowEdits};const result=await GrayEngine.render(item.prepared,options);if(!items.includes(item))continue;if(renderVersion!==item.version){item.status='pending';continue;}
        if(!result?.blob)throw new Error('照片未能导出，请重试。');if(item.url)URL.revokeObjectURL(item.url);item.result=result;item.url=URL.createObjectURL(result.blob);item.warnings=[...new Set([...(item.prepared.warnings||[]),...(result.warnings||[])])];item.status='done';item.error=null;
        if(needsPrepare){prepareTimes.push(performance.now()-started);if(prepareTimes.length>6)prepareTimes.shift();}
      }catch(error){if(items.includes(item)){if(renderVersion!==null&&renderVersion!==item.version){item.status='pending';}else{item.status='error';item.error=error?.message||'这张照片无法处理，请换一张试试。';}}}
      finally{if(!items.includes(item))release(item);activeItem=null;stage='';item.usedAt=Date.now();evictPrepared();render();}await yieldTask();
    }}finally{busy=false;stage='';render();if(items.some(x=>x.status==='pending'))run();}}
  function applySettings(item,options){if(JSON.stringify(item.settings)===JSON.stringify(options))return;remember(item);item.settings={...options};markPending(item);}
  function commitChange(){clearTimeout(settingsTimer);if(!pendingChange)return;const change=pendingChange;pendingChange=null;defaults={...change.settings,rotation:0};persistMeta();const item=items.find(x=>x.id===change.id);if(item)applySettings(item,change.settings);outputNames();render();run();}
  function settingsChanged(delayed=false){if(archiveBusy||comparing)return;const options=readSettings();const valid=validSettings(options);for(const id of ['output-width','output-height']){const v=Number($(id).value);$(id).setAttribute('aria-invalid',!Number.isInteger(v)||v<300||v>4000);} $('background-hex').setAttribute('aria-invalid',!/^#[0-9a-f]{6}$/i.test(options.background));
    for(const [id,[key,factor,min,max]]of Object.entries(numberFields))$(id).setAttribute('aria-invalid',!Number.isFinite(options[key])||options[key]*factor<min-0.000001||options[key]*factor>max+0.000001);
    if(!valid){clearTimeout(settingsTimer);pendingChange=null;render();say('请检查标红的设置：尺寸为 300–4000 的整数，位置和颜色需在允许范围内。');return;}
    $('background-color').value=options.background;updateLabels(options);pendingChange={id:selectedId,settings:options};clearTimeout(settingsTimer);$('download-one').disabled=true;$('download-all').disabled=true;$('download-psd').disabled=true;if(editorReady&&!editorDragging)GrayEditor.setDisabled(true);if(delayed)settingsTimer=setTimeout(commitChange,180);else commitChange();
  }
  function selectItem(id){stopCompare();setSplitMode(false);queueShadowPreview(null);commitChange();brushMode='move';currentTool='move';const previous=selected();if(previous&&previous.id!==id&&previous.originalUrl){URL.revokeObjectURL(previous.originalUrl);previous.originalUrl=null;}selectedId=id;const item=selected();if(item)item.usedAt=Date.now();fillSettings(item?.settings||defaults);view='result';render();persistMeta();}
  function addFiles(input){if(!window.PhotoCore||!window.GrayEngine){banner('本地处理组件未能加载，请重新打开工具。');return;}if(archiveBusy||editorDragging||assetBusy||comparing){say('请完成当前调整后再添加照片。');return;}commitChange();let skipped=0,duplicate=0,overflow=0,added=0;const seen=new Set(items.map(x=>x.path+'|'+x.file.size+'|'+x.file.lastModified));
    for(const value of input){const file=value.file||value;if(!/\.(jpe?g|png|webp)$/i.test(file.name)){skipped++;continue;}const path=PhotoCore.sanitizePath(value.path||file.webkitRelativePath||file.name);const key=path+'|'+file.size+'|'+file.lastModified;if(seen.has(key)){duplicate++;continue;}if(items.length>=LIMITS.files){overflow++;continue;}seen.add(key);const error=file.size>LIMITS.fileBytes?'单张照片超过 30 MB，请先缩小后再添加。':file.size===0?'照片文件为空，请重新选择。':null;const item={id:++serial,uid:crypto.randomUUID(),file,path,settings:{...defaults,rotation:0},shadowEdits:[],past:[],future:[],compareResult:null,compareSettings:null,version:0,status:error?'error':'pending',preError:!!error,error,prepared:null,result:null,url:null,originalUrl:null,warnings:[]};items.push(item);persistNew(item);queueThumb(item);added++;}
    const notes=[];if(skipped)notes.push('已跳过 '+skipped+' 个不支持的文件');if(duplicate)notes.push('已跳过 '+duplicate+' 张重复照片');if(overflow)notes.push('每批最多 '+LIMITS.files+' 张，另有 '+overflow+' 张未添加，请下载后分批处理');banner(notes.join('；'));if(added){outputNames();if(!selected())selectItem(items[0].id);render();run();}else if(!notes.length)say('没有找到可处理的 JPG、PNG 或 WebP 照片。');
  }
  function download(blob,name){const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=name;link.style.display='none';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
  function psdName(){const raw=$('psd-name').value.trim().replace(/\.(psd|zip)$/i,'');return raw?PhotoCore.sanitizePath(raw.replace(/[\\/]/g,'_')):'';}
  function refreshPsdDialog(){
    const done=items.filter(x=>x.status==='done'&&x.result),incomplete=items.length-done.length;
    $('psd-summary').textContent=items.length+' 张照片 · '+done.length+' 张已完成 · 每张照片一个独立画板';
    const sizes=new Map();for(const item of done){const size=item.settings.width+' × '+item.settings.height;sizes.set(size,(sizes.get(size)||0)+1);}
    $('psd-size-summary').textContent=Array.from(sizes,([size,count])=>size+' 像素 × '+count+' 张').join('；')||'处理完成后显示画板尺寸';
    let preflightError='';$('psd-layout-summary').textContent='';
    if(done.length){try{if(!window.GrayPsd?.describeGroup)throw new Error('PSD 导出组件未能加载，请重新打开工具。');const plan=GrayPsd.describeGroup(done.map(item=>({name:item.path,settings:item.settings})));$('psd-layout-summary').textContent=plan.columns+' 列 × '+plan.rows+' 行排列，PSD 总画布为 '+plan.width+' × '+plan.height+' 像素。';}catch(error){preflightError=error?.message||'这组画板无法导出，请检查照片尺寸。';}}
    $('psd-preflight').hidden=!preflightError;$('psd-preflight').textContent=preflightError;
    const working=items.some(isWorking)||!!pendingChange;
    $('psd-incomplete').hidden=!incomplete&&!working;
    $('psd-incomplete').textContent=working?'还有照片正在处理，请等待完成后导出。':'还有 '+incomplete+' 张照片未完成。请先重试，或从本批移除后再导出；整组 PSD 会包含列表里的每张照片。';
    $('psd-confirm').disabled=archiveBusy||assetBusy||editorDragging||comparing||working||!done.length||incomplete>0||!!preflightError||!psdName();
    $('psd-confirm').textContent=$('psd-images').checked?'导出 PSD + 成片':'导出 PSD';
  }
  function psdProgress(progress){
    if(psdAbort?.signal.aborted)return;
    const message=typeof progress==='string'?progress:progress?.message||progress?.stage||'正在生成 PSD…';
    const counts=typeof progress==='object'&&!progress?.message&&Number.isFinite(progress?.completed)&&Number.isFinite(progress?.total)?' '+progress.completed+' / '+progress.total:'';
    $('psd-progress-text').textContent=message+counts;
  }
  function closePsdDialog(){if(psdBusy){psdAbort?.abort();$('psd-cancel').disabled=true;$('psd-progress-text').textContent='正在取消，请稍候…';}else $('psd-dialog').close();}
  async function exportPsdGroup(){
    if(psdBusy||archiveBusy||assetBusy||editorDragging||comparing||pendingChange||items.some(isWorking))return;
    const group=items.slice(),name=psdName();
    if(!name||!group.length||group.some(item=>item.status!=='done'||!item.result)){refreshPsdDialog();return;}
    if(!window.GrayPsd?.exportGroup){$('psd-error').textContent='PSD 导出组件未能加载，请重新打开工具后再试。';$('psd-error').hidden=false;return;}
    const includeImages=$('psd-images').checked;
    psdBusy=true;archiveBusy=true;psdAbort=new AbortController();const signal=psdAbort.signal;
    $('psd-error').hidden=true;$('psd-progress').hidden=false;$('psd-name').disabled=true;$('psd-images').disabled=true;$('psd-confirm').disabled=true;$('psd-cancel').textContent='取消导出';render();psdProgress('正在准备整组 PSD…');
    try{
      // Photos whose working data was freed to save memory are rebuilt first (fast, from the recognition cache).
      for(const [index,item]of group.entries()){if(item.prepared)continue;psdProgress('正在重新载入第 '+(index+1)+' / '+group.length+' 张照片…');item.prepared=await GrayEngine.prepare(item.file);item.usedAt=Date.now();if(signal.aborted)throw new DOMException('导出已取消','AbortError');}
      const photos=group.map(item=>({name:item.path,prepared:item.prepared,result:item.result,settings:{...item.settings,shadowEdits:item.shadowEdits.map(stroke=>({...stroke,points:stroke.points.map(point=>[...point])}))}}));
      const psd=await GrayPsd.exportGroup(photos,{name,onProgress:psdProgress,signal});
      if(signal.aborted)throw new DOMException('导出已取消','AbortError');
      if(!(psd instanceof Blob)||!psd.size)throw new Error('PSD 文件未能生成，请重试。');
      let output=psd,filename=name+'.psd';
      if(includeImages){psdProgress('正在打包 PSD 和成片…');output=await PhotoCore.makeZip([{name:name+'.psd',blob:psd},...group.map(item=>({name:'成片/'+item.outputName,blob:item.result.blob}))],p=>{if(signal.aborted)throw new DOMException('导出已取消','AbortError');psdProgress('正在打包 PSD 和成片 '+p.completed+' / '+p.total);});filename=name+'.zip';}
      if(signal.aborted)throw new DOMException('导出已取消','AbortError');
      download(output,filename);$('psd-dialog').close();say('已开始下载 '+group.length+' 个画板的 PSD'+(includeImages?' 和全部成片':'')+'。');
    }catch(error){
      if(error?.name==='AbortError'||signal.aborted){$('psd-error').textContent='已取消导出，照片和调整仍然保留。';}else $('psd-error').textContent=error?.message||'PSD 导出未完成，请重试。';
      $('psd-error').hidden=false;
    }finally{psdBusy=false;archiveBusy=false;psdAbort=null;$('psd-progress').hidden=true;$('psd-name').disabled=false;$('psd-images').disabled=false;$('psd-cancel').disabled=false;$('psd-cancel').textContent='取消';render();}
  }
  $('choose').onclick=()=>$('file-input').click();$('choose-folder').onclick=()=>$('folder-input').click();for(const id of ['file-input','folder-input'])$(id).onchange=e=>{addFiles(Array.from(e.target.files));e.target.value='';};
  $('file-list').onclick=e=>{const button=e.target.closest('button[data-action]');if(!button||archiveBusy||editorDragging||assetBusy||comparing)return;const item=items.find(x=>x.id===Number(button.dataset.id));if(!item)return;if(button.dataset.action==='select')selectItem(item.id);if(button.dataset.action==='retry'){item.version++;item.status='pending';item.error=null;render();run();}if(button.dataset.action==='remove'){commitChange();const index=items.indexOf(item);items=items.filter(x=>x!==item);clearTimeout(saveTimers.get(item.uid));if(sessionReady)GraySession.removePhoto(item.uid);if(item!==activeItem)release(item);if(selectedId===item.id){setSplitMode(false);selectedId=items[Math.min(index,items.length-1)]?.id||null;fillSettings(selected()?.settings||defaults);view='result';}outputNames();render();const next=items[Math.min(index,items.length-1)];if(next)$('file-list').querySelector('[data-id="'+next.id+'"][data-action="select"]')?.focus({preventScroll:true});else $('choose').focus({preventScroll:true});}};
  $('split-compare').onclick=()=>setSplitMode(!splitOn);
  $('review-filter').onclick=()=>{reviewOnly=!reviewOnly;render();};
  $('clear').onclick=()=>{if(editorDragging||assetBusy||archiveBusy||comparing)return;setSplitMode(false);queueShadowPreview(null);clearTimeout(settingsTimer);pendingChange=null;const previous=items;items=[];selectedId=null;for(const item of previous){clearTimeout(saveTimers.get(item.uid));if(item!==activeItem)release(item);}saveTimers.clear();if(sessionReady){GraySession.clearPhotos();persistMeta();}banner('');fillSettings(defaults);render();$('choose').focus({preventScroll:true});};
  for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>{stopCompare();setSplitMode(false);view=button.dataset.view;if(view==='original'){brushMode='move';currentTool='move';}renderPreview();updateControls();};
  $('size-preset').onchange=()=>{const custom=$('size-preset').value==='custom';$('custom-size').hidden=!custom;if(!custom){const dimensions=$('size-preset').value.split('x');$('output-width').value=dimensions[0];$('output-height').value=dimensions[1];}settingsChanged();};for(const id of ['output-width','output-height','background-hex'])$(id).onchange=()=>settingsChanged();$('background-color').oninput=()=>{$('background-hex').value=$('background-color').value.toUpperCase();settingsChanged(true);};for(const id of ['scale','shadow','shadow-range','shadow-softness','exposure','contrast','temperature','saturation','logo-width','logo-opacity']){$(id).oninput=()=>settingsChanged(true);$(id).onchange=commitChange;}
  document.querySelectorAll('[data-format]').forEach(button=>button.onclick=()=>{currentFormat=button.dataset.format;document.querySelectorAll('[data-format]').forEach(x=>x.setAttribute('aria-pressed',x===button));settingsChanged();});
  $('reset-settings').onclick=()=>{fillSettings(DEFAULTS);settingsChanged();};$('apply-all').onclick=()=>{if(editorDragging||assetBusy||archiveBusy||comparing)return;commitChange();if(validSettings(readSettings()))$('apply-dialog').showModal();};
  document.querySelectorAll('[data-panel]').forEach(button=>button.onclick=()=>setPanel(button.dataset.panel));
  document.querySelectorAll('[data-tool]').forEach(button=>button.onclick=()=>setTool(button.dataset.tool));
  $('history-undo').onclick=()=>historyStep();$('history-redo').onclick=()=>historyStep(true);
  $('rotation').oninput=()=>{$('rotation-number').value=$('rotation').value;settingsChanged(true);};$('rotation').onchange=commitChange;
  document.querySelectorAll('[data-rotate-step]').forEach(button=>button.onclick=()=>changeFields({rotation:Math.max(-180,Math.min(180,Math.round((Number($('rotation-number').value)+Number(button.dataset.rotateStep))*10)/10))}));
  $('rotation-reset').onclick=()=>changeFields({rotation:0});
  $('zoom-select').onchange=()=>{const value=$('zoom-select').value;if(value==='fit'||value==='1'||value==='2')GrayEditor.setZoom(value==='fit'?'fit':Number(value));};
  window.addEventListener('gray-editor-zoom',e=>{const {mode,scale}=e.detail||{},select=$('zoom-select');select.querySelector('[data-custom-zoom]')?.remove();if(mode==='fit')select.value='fit';else if(scale===1||scale===2)select.value=String(scale);else if(Number.isFinite(scale)){const option=new Option(Math.round(scale*100)+'%','custom');option.dataset.customZoom='';option.disabled=true;select.add(option);select.value='custom';}});
  $('compare-hold').addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();$('compare-hold').setPointerCapture(e.pointerId);startCompare();});
  for(const name of ['pointerup','pointercancel','lostpointercapture'])$('compare-hold').addEventListener(name,stopCompare);
  $('compare-hold').addEventListener('keydown',e=>{if([' ','Enter'].includes(e.key)){e.preventDefault();if(!e.repeat)startCompare();}});
  $('compare-hold').addEventListener('keyup',e=>{if([' ','Enter'].includes(e.key)){e.preventDefault();stopCompare();}});
  window.addEventListener('pointerup',stopCompare);window.addEventListener('blur',stopCompare);
  $('apply-cancel').onclick=()=>$('apply-dialog').close();
  $('apply-confirm').onclick=()=>{
    if(editorDragging||assetBusy||archiveBusy||comparing)return;
    const source=readSettings();if(!validSettings(source))return;
    const groups={layout:['background','scale','offsetX','offsetY'],tone:['exposure','contrast','temperature','saturation'],shadow:['shadow','shadowMode','shadowRange','shadowSoftness'],logo:['logoEnabled','logoId','logoX','logoY','logoWidth','logoOpacity'],export:['width','height','format','quality']};
    const keys=Array.from(document.querySelectorAll('[data-apply-group]:checked')).flatMap(x=>groups[x.dataset.applyGroup]||[]);if($('apply-rotation').checked)keys.push('rotation');
    if(!keys.length){say('请至少选择一组要应用的设置。');return;}
    const changes=Object.fromEntries(keys.map(key=>[key,source[key]]));for(const item of items)applySettings(item,{...item.settings,...changes});
    defaults={...defaults,...changes,rotation:0};persistMeta();$('apply-dialog').close();outputNames();render();run();say('已应用选中的设置，每张照片的阴影笔画保留。');
  };
  window.addEventListener('keydown',e=>{
    if(e.defaultPrevented||document.querySelector('dialog[open]')||e.target.closest('input,textarea,select,[contenteditable="true"]'))return;
    const key=e.key.toLowerCase();
    if((e.ctrlKey||e.metaKey)&&['z','y'].includes(key)){e.preventDefault();historyStep(key==='y'||e.shiftKey);return;}
    if(e.ctrlKey||e.metaKey||e.altKey||editorDragging||comparing)return;
    if(key==='c'&&selected()?.status==='done'&&view==='result'){e.preventDefault();setSplitMode(!splitOn);return;}
    if(['b','v','r'].includes(key)&&selected()?.status==='done'&&view==='result'&&!splitOn){e.preventDefault();setTool({b:'shadow',v:'move',r:'rotate'}[key]);}
    if(['[',']'].includes(key)&&brushMode!=='move'){e.preventDefault();brushSize=Math.max(20,Math.min(300,brushSize+(key==='['?-10:10)));$('shadow-brush-size').value=brushSize;updateBrushControls();}
    if(['ArrowLeft','ArrowRight'].includes(e.key)&&!$('editor-canvas').contains(e.target)&&!assetBusy&&!archiveBusy){const next=items[items.indexOf(selected())+(e.key==='ArrowLeft'?-1:1)];if(next){e.preventDefault();selectItem(next.id);$('file-list').querySelector('.selected')?.scrollIntoView({block:'nearest'});}}
  });
  for(const id of ['offset-x','offset-y','logo-x','logo-y','rotation-number'])$(id).onchange=()=>settingsChanged();
  $('shadow-mode').onchange=()=>{if($('shadow-mode').value==='none')brushMode='move';settingsChanged();};
  document.querySelectorAll('[data-brush]').forEach(button=>button.onclick=()=>setBrushMode(button.dataset.brush));
  for(const id of ['shadow-brush-size','shadow-brush-hardness','shadow-brush-opacity'])$(id).oninput=()=>{brushSize=Number($('shadow-brush-size').value);brushHardness=Number($('shadow-brush-hardness').value);brushOpacity=Number($('shadow-brush-opacity').value);updateBrushControls();};
  $('shadow-undo').onclick=()=>{if(!editorDragging&&!pendingChange&&selected()?.status==='done')changeShadowEdits((selected().shadowEdits||[]).slice(0,-1));};
  $('shadow-clear').onclick=()=>{if(!editorDragging&&!pendingChange&&selected()?.status==='done'){changeShadowEdits([]);say('已清空这张照片的阴影笔画。');}};
  $('reset-tone').onclick=()=>changeFields({exposure:0,contrast:0,temperature:0,saturation:0});
  document.querySelectorAll('[data-layout]').forEach(button=>button.onclick=()=>changeFields(layoutSettings(button.dataset.layout)));
  $('logo-enabled').onchange=()=>settingsChanged();
  $('logo-default').onclick=()=>changeFields({logoEnabled:true,logoId:'default',logoX:DEFAULTS.logoX,logoY:DEFAULTS.logoY,logoWidth:DEFAULTS.logoWidth,logoOpacity:1});
  $('logo-select').onchange=()=>changeFields({logoId:$('logo-select').value,logoEnabled:true});
  $('logo-upload').onclick=()=>$('logo-input').click();$('logo-input').onchange=e=>{const file=e.target.files[0];e.target.value='';if(!file)return;assetAction(async()=>{const logo=await GrayAssets.addLogo(file);await refreshAssets();changeFields({logoId:logo.id,logoEnabled:true});say('Logo 已保存，可用于其他照片。');});};
  $('logo-delete').onclick=()=>assetAction(async()=>{if(currentLogoId==='default')return;const id=currentLogoId;if(items.some(x=>x.settings.logoId===id))throw new Error('当前照片正在使用这个 Logo，请先为这些照片选择其他 Logo。');await GrayAssets.deleteLogo(id);changeFields({logoId:'default'});await refreshAssets();say('已删除这个 Logo。');});
  document.querySelectorAll('[data-logo-corner]').forEach(button=>button.onclick=()=>assetAction(async()=>{const s=readSettings();if(!validSettings(s))throw new Error('请先检查右侧设置。');const logo=await GrayAssets.getLogo(s.logoId);const h=s.logoWidth*s.width/s.height*logo.height/logo.width;const corner=button.dataset.logoCorner;changeFields({logoX:corner.endsWith('r')?Math.max(0,1-DEFAULTS.logoX-s.logoWidth):DEFAULTS.logoX,logoY:corner.startsWith('b')?Math.max(0,1-DEFAULTS.logoY-h):DEFAULTS.logoY});}));
  $('template-save').onclick=()=>assetAction(async()=>{const s=readSettings();if(!validSettings(s))throw new Error('请先检查右侧设置。');const template=await GrayAssets.saveTemplate($('template-name').value,s);await refreshAssets(template.id);$('template-name').value='';say('模板已保存，下次打开仍可使用。');});
  $('template-name').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('template-save').click();}});
  $('template-select').onchange=()=>{const template=templates.find(x=>x.id===$('template-select').value);if(template){const options={...DEFAULTS,...template.settings,rotation:selected()?.settings.rotation||0};if(!validSettings(options)){say('这份模板的设置无效，请重新保存。');return;}fillSettings(options);settingsChanged();say('已套用“'+template.name+'”，可继续微调。');}updateControls();};
  $('template-delete').onclick=()=>assetAction(async()=>{const id=$('template-select').value;if(!id)return;await GrayAssets.deleteTemplate(id);await refreshAssets('');say('模板已删除，当前照片的效果仍然保留。');});
  $('select-shoe').onclick=()=>{setTool('move');GrayEditor.select('shoe');};$('select-logo').onclick=()=>{setBrushMode('move');setPanel('logo');GrayEditor.select('logo');};$('deselect-editor').onclick=()=>GrayEditor.deselect();
  window.addEventListener('gray-editor-busy',e=>{editorDragging=!!e.detail;if(editorDragging)interactionOwnerId=editorOwnerId;else interactionOwnerId=null;render();});
  $('download-one').onclick=()=>{const item=selected();if(item?.result&&item.status==='done'&&!pendingChange&&!editorDragging&&!assetBusy&&!archiveBusy&&!comparing&&validSettings(readSettings()))download(item.result.blob,item.outputName.split('/').pop());};
  $('download-psd').onclick=()=>{if(archiveBusy||assetBusy||editorDragging||comparing||!items.length)return;commitChange();if(!$('psd-name').value.trim())$('psd-name').value=items[0].file.name.replace(/\.[^.]+$/,'').slice(0,64)||'鞋款';$('psd-error').hidden=true;refreshPsdDialog();$('psd-dialog').showModal();};
  $('psd-name').oninput=refreshPsdDialog;$('psd-images').onchange=refreshPsdDialog;
  $('psd-name').addEventListener('keydown',e=>{if(e.key==='Enter'&&!$('psd-confirm').disabled){e.preventDefault();exportPsdGroup();}});
  $('psd-cancel').onclick=closePsdDialog;$('psd-confirm').onclick=exportPsdGroup;
  $('psd-dialog').addEventListener('cancel',e=>{if(psdBusy){e.preventDefault();closePsdDialog();}});
  $('download-all').onclick=async()=>{if(archiveBusy||editorDragging||assetBusy||items.some(isWorking)||pendingChange||!validSettings(readSettings()))return;const completed=items.filter(x=>x.status==='done');if(!completed.length)return;archiveBusy=true;render();document.querySelectorAll('.settings input,.settings select,.settings button,#choose,#choose-folder').forEach(x=>x.disabled=true);
    try{const zip=await PhotoCore.makeZip(completed.map(x=>({name:x.outputName,blob:x.result.blob})),p=>{$('download-label').textContent='正在打包 '+p.completed+' / '+p.total;});const now=new Date();const stamp=now.getFullYear()+String(now.getMonth()+1).padStart(2,'0')+String(now.getDate()).padStart(2,'0');download(zip,'轻图_灰底照片_'+stamp+'.zip');say('已开始下载 '+completed.length+' 张照片的压缩包。');}catch(error){banner(error.message||'打包未完成，请尝试逐张下载。');}finally{archiveBusy=false;document.querySelectorAll('.settings input,.settings select,.settings button,#choose,#choose-folder').forEach(x=>x.disabled=false);render();}
  };
  async function readEntry(entry,prefix='',collection=[]){if(collection.length>=300)return collection;if(entry.isFile){try{const file=await new Promise((resolve,reject)=>entry.file(resolve,reject));collection.push({file,path:prefix+file.name});}catch{}}else if(entry.isDirectory){const reader=entry.createReader();while(collection.length<300){const batch=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));if(!batch.length)break;for(const child of batch){await readEntry(child,prefix+entry.name+'/',collection);if(collection.length>=300)break;}}}return collection;}
  const zone=$('dropzone');window.addEventListener('dragover',e=>{if(Array.from(e.dataTransfer?.types||[]).includes('Files')){e.preventDefault();e.dataTransfer.dropEffect='copy';}});zone.addEventListener('dragenter',e=>{e.preventDefault();dropDepth++;zone.classList.add('drag');});zone.addEventListener('dragleave',()=>{if(--dropDepth<=0){dropDepth=0;zone.classList.remove('drag');}});window.addEventListener('drop',async e=>{e.preventDefault();dropDepth=0;zone.classList.remove('drag');if(!e.dataTransfer)return;const files=Array.from(e.dataTransfer.files);const entries=Array.from(e.dataTransfer.items||[]).map(x=>x.webkitGetAsEntry?.()).filter(Boolean);try{if(entries.length){const collection=[];for(const entry of entries)await readEntry(entry,'',collection);addFiles(collection);if(collection.length>=300)say('文件夹较大，请每批选择最多 '+LIMITS.files+' 张。');}else if(files.length)addFiles(files);}catch{banner('文件夹未能完整读取，请使用“选择文件夹”重试。');}});
  $('help-open').onclick=()=>$('help').showModal();$('help-close').onclick=()=>$('help').close();$('help').onclick=e=>{if(e.target===$('help')){const rect=$('help').getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)$('help').close();}};
  // With the batch saved locally a refresh loses nothing, so only warn when storage is unavailable.
  window.addEventListener('beforeunload',e=>{if(!sessionReady&&items.some(x=>x.result)){e.preventDefault();e.returnValue='';}});
  window.addEventListener('pagehide',()=>{for(const item of items)if(saveTimers.has(item.uid))flushEdits(item);});
  if(window.GrayEditor){try{GrayEditor.mount($('editor-canvas'),delta=>{if(!selected()||selectedId!==(interactionOwnerId??editorOwnerId)||archiveBusy)return;if(delta&&Object.hasOwn(delta,'shadowPreview')){queueShadowPreview(delta.shadowPreview);return;}if(delta?.shadowStroke){addShadowStroke(delta.shadowStroke);return;}changeFields(delta);});editorReady=true;}catch{say('拖动组件未能加载，仍可使用右侧数值调整。');}}
  fillSettings(defaults);setPanel('layout');render();if(!window.PhotoCore||!window.GrayEngine){banner('本地处理组件未能加载。请通过配套启动程序打开，或重新打开工具。');$('choose').disabled=true;$('choose-folder').disabled=true;}
  // Bring back the last batch: photos, settings and strokes. Recognition comes from the cache, so it finishes quickly.
  async function restoreSession(){
    if(!window.GraySession||!window.PhotoCore||!window.GrayEngine||!(await GraySession.available()))return;
    const [records,meta]=await Promise.all([GraySession.loadPhotos(),GraySession.loadMeta()]);
    if(meta?.defaults){const saved={...DEFAULTS,...meta.defaults,rotation:0};if(validSettings(saved))defaults=saved;}
    sessionReady=true;
    // Photos added while loading win; the stored batch is replaced by them.
    if(items.length){await GraySession.clearPhotos();for(const item of items)persistNew(item);persistMeta();return;}
    serial=Math.max(serial,...records.map(record=>Number(record.order)||0));
    for(const record of records.slice(0,LIMITS.files)){
      const file=record.file instanceof File?record.file:new File([record.file],record.name||record.path.split('/').pop()||'photo.jpg',{type:record.file.type});
      const settings={...DEFAULTS,...record.edits?.settings},strokes=Array.isArray(record.edits?.shadowEdits)?record.edits.shadowEdits:[];
      const restored={id:++serial,uid:record.uid,file,path:record.path,settings:validSettings(settings)?settings:{...defaults,rotation:0},shadowEdits:strokes,past:[],future:[],compareResult:null,compareSettings:null,version:0,status:'pending',preError:false,error:null,prepared:null,result:null,url:null,originalUrl:null,warnings:[]};items.push(restored);queueThumb(restored);
    }
    if(!items.length){fillSettings(defaults);return;}
    outputNames();selectItem((items.find(x=>x.uid===meta?.selected)||items[0]).id);
    banner('已恢复上次的 '+items.length+' 张照片和调整；识别过的照片无需重新识别，很快就能处理完。');render();run();
  }
  restoreSession().catch(()=>{});
  if(window.GrayAssets){GrayAssets.init().then(async()=>{assetsReady=true;await refreshAssets();}).catch(error=>{assetsReady=false;updateControls();banner(error?.message||'品牌模板未能读取，默认 Logo 仍可使用。');});}else banner('Logo 组件未能加载，请重新打开工具。');
})();
