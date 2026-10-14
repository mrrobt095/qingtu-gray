/* Placement, soft shadow brushes and view controls. Final pixels are rendered by GrayProcessing. */
(() => {
  'use strict';
  const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
  let host,callback,stage,layer,frame,content,overlay,background,patch,shoe,logo,transformer,cursor,cursorEdge,hardnessRing,observer;
  let result=null,previewResult=null,settings=null,disabled=true,visible=false,generation=0,chosen=null,interacting=false;
  let brush={mode:'move',size:60,hardness:0,opacity:.25},stroke=null,action=null,canceling=false,previewTimer=null,lastPreview=0;
  let zoomMode='fit',zoomScale=1,panX=0,panY=0,panGesture=null,spaceHeld=false,hovering=false;
  function setInteracting(value){if(interacting===value)return;interacting=value;window.dispatchEvent(new CustomEvent('gray-editor-busy',{detail:value}));}
  function emitZoom(){window.dispatchEvent(new CustomEvent('gray-editor-zoom',{detail:{mode:zoomMode,scale:frame?.scaleX()||1}}));}
  function resize(){
    if(!host||!stage||!visible||!result)return;
    const w=host.clientWidth,h=host.clientHeight;if(!w||!h)return;
    const fit=Math.min(w/result.width,h/result.height),s=zoomMode==='fit'?fit:zoomScale;
    const limitX=Math.max(0,(w+result.width*s)/2-Math.min(80,w/3)),limitY=Math.max(0,(h+result.height*s)/2-Math.min(80,h/3));
    panX=clamp(panX,-limitX,limitX);panY=clamp(panY,-limitY,limitY);
    stage.size({width:w,height:h});frame.position({x:(w-result.width*s)/2+panX,y:(h-result.height*s)/2+panY});frame.scale({x:s,y:s});layer.batchDraw();emitZoom();
  }
  function setZoom(value='fit'){
    cancelInteraction();
    if(value==='fit'){zoomMode='fit';panX=panY=0;}
    else {const number=Number(value);if(!Number.isFinite(number)||number<=0)return;zoomMode='custom';zoomScale=clamp(number,.1,4);}
    resize();return {mode:zoomMode,scale:frame?.scaleX()||1};
  }
  function deselect(){chosen=null;transformer?.nodes([]);layer?.batchDraw();}
  function select(name){
    const target=name==='logo'?logo:shoe;
    if(disabled||!visible||brush.mode!=='move'||!target?.visible())return;
    chosen=name;transformer.nodes([target]);layer.batchDraw();
  }
  function placementCenter(p){return{x:p.centerX??p.subjectX+p.subjectWidth/2,y:p.centerY??p.subjectY+p.subjectHeight/2};}
  function syncPatch(){
    if(!result)return;
    const p=result.placement,shown=previewResult||result,r=shown.patchPlacement||shown.placement,ratio=shoe.scaleX(),center=placementCenter(p);
    // Rotation is already baked into the raster. Only translation and uniform
    // scaling are needed while the user drags the rotated subject rectangle.
    patch.setAttrs({x:shoe.x()+(r.x-center.x)*ratio,y:shoe.y()+(r.y-center.y)*ratio,width:r.width*ratio,height:r.height*ratio,rotation:0});layer.batchDraw();
  }
  function showPreview(nextResult){
    if(!result||!visible||!patch)return false;
    if(nextResult&&(!nextResult.patchCanvas||nextResult.width!==result.width||nextResult.height!==result.height))return false;
    previewResult=nextResult||null;patch.image((previewResult||result).patchCanvas);syncPatch();return true;
  }
  function resetGeometry(){
    if(!result)return;
    const p=result.placement,c=placementCenter(p);
    shoe.setAttrs({x:c.x,y:c.y,width:p.subjectWidth,height:p.subjectHeight,offsetX:p.subjectWidth/2,offsetY:p.subjectHeight/2,scaleX:1,scaleY:1,rotation:p.rotation||0});syncPatch();
    const l=result.logoPlacement;if(l)logo.setAttrs({x:l.x,y:l.y,width:l.width,height:l.height,scaleX:1,scaleY:1,rotation:0});transformer.forceUpdate();
  }
  function halfExtents(node){const r=node.rotation()*Math.PI/180,c=Math.abs(Math.cos(r)),s=Math.abs(Math.sin(r)),w=node.width()*node.scaleX(),h=node.height()*node.scaleY();return{x:(w*c+h*s)/2,y:(w*s+h*c)/2};}
  function clampedPosition(node,x,y){
    if(node===logo)return{x:clamp(x,0,Math.max(0,result.width-node.width()*node.scaleX())),y:clamp(y,0,Math.max(0,result.height-node.height()*node.scaleY()))};
    const half=halfExtents(node),lx=result.width*.01+half.x,hx=result.width*.99-half.x,ly=result.height*.01+half.y,hy=result.height*.99-half.y;
    return{x:lx>hx?result.width/2:clamp(x,lx,hx),y:ly>hy?result.height/2:clamp(y,ly,hy)};
  }
  function clampNode(node){node.position(clampedPosition(node,node.x(),node.y()));}
  function commitShoe(transforming){
    if(canceling)return;
    if(!result||disabled){action=null;setInteracting(false);return;}
    clampNode(shoe);syncPatch();
    const w=shoe.width()*shoe.scaleX(),h=shoe.height()*shoe.scaleY();
    const changes={offsetX:clamp(shoe.x()/result.width-.5,-.5,.5),offsetY:clamp(shoe.y()/result.height-.5,-.5,.5)};
    if(transforming)changes.scale=clamp(Math.max(w/result.width,h/result.height),.2,.96);
    action=null;try{callback(changes);}finally{setInteracting(false);}
  }
  function commitLogo(){
    if(canceling)return;
    if(!result||disabled){action=null;setInteracting(false);return;}
    clampNode(logo);action=null;
    try{callback({logoX:clamp(logo.x()/result.width,0,1),logoY:clamp(logo.y()/result.height,0,1),logoWidth:clamp(logo.width()*logo.scaleX()/result.width,.02,.8)});}finally{setInteracting(false);}
  }
  function clampDrag(node,pos){
    const s=frame.scaleX(),f=frame.position(),clamped=clampedPosition(node,(pos.x-f.x)/s,(pos.y-f.y)/s);
    return{x:f.x+clamped.x*s,y:f.y+clamped.y*s};
  }
  function outputPoint(event){const r=host.getBoundingClientRect(),s=frame.scaleX();return{x:(event.clientX-r.left-frame.x())/s,y:(event.clientY-r.top-frame.y())/s};}
  function inCanvas(p){return result&&p.x>=0&&p.y>=0&&p.x<=result.width&&p.y<=result.height;}
  function sourcePoint(p){
    const g=result?.sourceGeometry,placement=result?.placement;if(!g||!(g.width>0&&g.height>0&&placement.scale>0))return null;
    const t=result.sourceTransform;let x,y;
    if(t){const det=t.a*t.d-t.b*t.c;if(!Number.isFinite(det)||Math.abs(det)<1e-10)return null;const px=p.x-t.e,py=p.y-t.f;x=(t.d*px-t.c*py)/det;y=(-t.b*px+t.a*py)/det;}
    else{x=g.crop.x+(p.x-placement.x)/placement.scale;y=g.crop.y+(p.y-placement.y)/placement.scale;}
    if(x<0||y<0||x>g.width||y>g.height)return null;
    return[clamp(x/g.width,0,1),clamp(y/g.height,0,1)];
  }
  function hideCursor(){cursor?.visible(false);cursorEdge?.visible(false);hardnessRing?.visible(false);}
  function updateCursor(p){
    const show=!disabled&&visible&&!spaceHeld&&!panGesture&&brush.mode!=='move'&&inCanvas(p);cursor.visible(show);cursorEdge.visible(show);hardnessRing.visible(show&&brush.hardness>0&&brush.hardness<.98);
    if(show){const attrs={x:p.x,y:p.y,radius:brush.size/2};cursor.setAttrs({...attrs,strokeWidth:1/frame.scaleX()});cursorEdge.setAttrs({...attrs,strokeWidth:2.5/frame.scaleX()});hardnessRing.setAttrs({x:p.x,y:p.y,radius:brush.size/2*brush.hardness,strokeWidth:1/frame.scaleX(),dash:[3/frame.scaleX(),3/frame.scaleX()]});}
    host.style.cursor=panGesture?'grabbing':spaceHeld?'grab':show?'none':'default';layer.batchDraw();
  }
  function strokeValue(active){return{mode:active.mode,radius:active.radius,hardness:active.hardness,opacity:active.opacity,points:active.points.map(p=>[...p])};}
  function sendPreview(){previewTimer=null;if(!stroke||!stroke.points.length)return;lastPreview=performance.now();callback({shadowPreview:strokeValue(stroke)});}
  function schedulePreview(){if(previewTimer!==null)return;const delay=Math.max(0,80-(performance.now()-lastPreview));if(!delay)sendPreview();else previewTimer=setTimeout(sendPreview,delay);}
  function addPoint(p,force=false){
    if(!stroke||!inCanvas(p))return;
    const normalized=sourcePoint(p);if(!normalized)return;
    const previous=stroke.lastOutput;
    if(!force&&previous&&Math.hypot(p.x-previous.x,p.y-previous.y)<Math.max(.5,stroke.size/20))return;
    if(previous&&Math.hypot(p.x-previous.x,p.y-previous.y)<.01)return;
    if(stroke.points.length>=12000)return;
    stroke.points.push(normalized);stroke.lastOutput=p;schedulePreview();
  }
  function finishStroke(commit){
    if(!stroke)return;
    const completed=stroke;stroke=null;if(previewTimer!==null){clearTimeout(previewTimer);previewTimer=null;}
    try{if(host.hasPointerCapture?.(completed.pointerId))host.releasePointerCapture(completed.pointerId);}catch{}
    // Invalidate pending async previews before the committed render is queued.
    callback({shadowPreview:null});showPreview(null);
    try{if(commit&&completed.points.length)callback({shadowStroke:strokeValue(completed)});}finally{setInteracting(false);}
  }
  function endPan(){
    if(!panGesture)return;const ended=panGesture;panGesture=null;try{if(host.hasPointerCapture?.(ended.pointerId))host.releasePointerCapture(ended.pointerId);}catch{}
    updateInteractionMode();setInteracting(false);
  }
  function cancelInteraction(){
    finishStroke(false);endPan();
    if(action){canceling=true;action=null;try{shoe?.stopDrag();logo?.stopDrag();transformer?.stopTransform();resetGeometry();}finally{canceling=false;}}
    hideCursor();if(host)host.style.cursor=spaceHeld?'grab':'default';setInteracting(false);layer?.batchDraw();
  }
  function updateInteractionMode(){
    if(!stage)return;
    const move=!disabled&&brush.mode==='move'&&!spaceHeld&&!panGesture;shoe.draggable(move);logo.draggable(move);stage.listening(move);
    if(!move)transformer.nodes([]);else if(chosen)select(chosen);
    hideCursor();host.style.cursor=panGesture?'grabbing':spaceHeld?'grab':'default';host.style.touchAction='none';layer.batchDraw();
  }
  function setBrush(value={}){
    const mode=['move','erase','restore'].includes(value.mode)?value.mode:'move',size=Number(value.size),hardness=Number(value.hardness??0),opacity=Number(value.opacity??.25);
    const next={mode,size:Number.isFinite(size)?clamp(size,4,600):60,hardness:Number.isFinite(hardness)?clamp(hardness,0,1):0,opacity:Number.isFinite(opacity)?clamp(opacity,0,1):.25};
    if(Object.keys(next).every(key=>next[key]===brush[key]))return;
    cancelInteraction();brush=next;if(mode!=='move')deselect();updateInteractionMode();
  }
  function transformedBox(box){
    const angle=box.rotation||0,c=Math.cos(angle),s=Math.sin(angle),points=[[0,0],[box.width,0],[0,box.height],[box.width,box.height]].map(([x,y])=>({x:box.x+x*c-y*s,y:box.y+x*s+y*c}));
    return{left:Math.min(...points.map(p=>p.x)),right:Math.max(...points.map(p=>p.x)),top:Math.min(...points.map(p=>p.y)),bottom:Math.max(...points.map(p=>p.y))};
  }
  function isEditable(element){return !!element?.closest?.('input,textarea,select,[contenteditable="true"]');}
  function mount(element,onChange){
    if(!window.Konva)throw new Error('拖动组件未能加载，请重新打开工具。');if(stage)return;
    host=element;callback=onChange;host.tabIndex=0;host.setAttribute('role','img');host.setAttribute('aria-label','可编辑商品画布。拖动鞋子或 Logo，四角等比缩放；柔边画笔调整阴影。按住空格拖动画布。');
    Konva.pixelRatio=Math.min(window.devicePixelRatio||1,2);
    stage=new Konva.Stage({container:host,width:1,height:1});layer=new Konva.Layer();stage.add(layer);frame=new Konva.Group({name:'canvas-frame'});layer.add(frame);
    background=new Konva.Rect({fill:'#e6e6e6'});frame.add(background);content=new Konva.Group({name:'artwork'});frame.add(content);
    patch=new Konva.Image({name:'shoe-patch',listening:false});content.add(patch);
    shoe=new Konva.Rect({name:'shoe',fill:'rgba(0,0,0,0)',draggable:true});content.add(shoe);
    logo=new Konva.Image({name:'logo',draggable:true});content.add(logo);
    transformer=new Konva.Transformer({name:'selection',rotateEnabled:false,flipEnabled:false,keepRatio:true,enabledAnchors:['top-left','top-right','bottom-left','bottom-right'],borderStroke:'#267b60',anchorStroke:'#267b60',anchorFill:'#fff',anchorSize:9,padding:2,ignoreStroke:true,
      boundBoxFunc(oldBox,newBox){
        if(!result)return oldBox;
        const s=frame.scaleX(),f=frame.position(),isLogo=chosen==='logo',inset=isLogo?0:.01,max=isLogo?.8:.96;
        const belowMinimum=isLogo?newBox.width<.02*result.width*s:Math.max(newBox.width/(result.width*s),newBox.height/(result.height*s))<.2;
        if(belowMinimum||newBox.height<4||newBox.width>result.width*max*s+.1||newBox.height>result.height*(isLogo?1:.96)*s+.1)return oldBox;
        const b=transformedBox(newBox);
        return b.left<f.x+result.width*inset*s-.1||b.top<f.y+result.height*inset*s-.1||b.right>f.x+result.width*(1-inset)*s+.1||b.bottom>f.y+result.height*(1-inset)*s+.1?oldBox:newBox;
      }});frame.add(transformer);
    for(const node of[shoe,logo]){
      node.on('mousedown touchstart',e=>{if(disabled||brush.mode!=='move'||spaceHeld)return;e.cancelBubble=true;select(node===logo?'logo':'shoe');host.focus({preventScroll:true});});
      node.on('dragstart transformstart',e=>{action={node,transform:e.type==='transformstart'};setInteracting(true);});node.dragBoundFunc(pos=>clampDrag(node,pos));
      node.on('mouseenter',()=>{if(!disabled&&brush.mode==='move')host.style.cursor=spaceHeld?'grab':'move';});node.on('mouseleave',()=>{if(brush.mode==='move')host.style.cursor=spaceHeld?'grab':'default';});
    }
    shoe.on('dragmove transform',syncPatch);shoe.on('dragend',()=>commitShoe(false));shoe.on('transformend',()=>commitShoe(true));logo.on('dragend transformend',commitLogo);
    stage.on('mousedown touchstart',e=>{if(e.target===stage||e.target===background)deselect();});
    overlay=new Konva.Group({listening:false});frame.add(overlay);
    cursorEdge=new Konva.Circle({visible:false,stroke:'#252525',opacity:.75,listening:false});overlay.add(cursorEdge);
    cursor=new Konva.Circle({visible:false,stroke:'#fff',opacity:.95,listening:false});overlay.add(cursor);
    hardnessRing=new Konva.Circle({visible:false,stroke:'#fff',opacity:.65,listening:false});overlay.add(hardnessRing);
    host.addEventListener('pointerdown',event=>{
      if(disabled||!visible||event.button!==0||stroke||panGesture)return;
      if(spaceHeld){event.preventDefault();event.stopImmediatePropagation();host.focus({preventScroll:true});panGesture={pointerId:event.pointerId,x:event.clientX,y:event.clientY,panX,panY};try{host.setPointerCapture(event.pointerId);}catch{}setInteracting(true);updateInteractionMode();return;}
      if(brush.mode==='move')return;
      const p=outputPoint(event),g=result?.sourceGeometry;if(!inCanvas(p)||!sourcePoint(p)||!g)return;
      event.preventDefault();event.stopImmediatePropagation();host.focus({preventScroll:true});
      stroke={pointerId:event.pointerId,mode:brush.mode,size:brush.size,hardness:brush.hardness,opacity:brush.opacity,radius:Math.min(1,brush.size/2/(result.placement.scale*Math.max(g.width,g.height))),points:[],lastOutput:null};
      try{host.setPointerCapture(event.pointerId);}catch{}setInteracting(true);addPoint(p,true);updateCursor(p);
    },true);
    host.addEventListener('pointermove',event=>{
      if(panGesture?.pointerId===event.pointerId){event.preventDefault();panX=panGesture.panX+event.clientX-panGesture.x;panY=panGesture.panY+event.clientY-panGesture.y;resize();return;}
      if(!visible||brush.mode==='move')return;const p=outputPoint(event);updateCursor(p);if(stroke&&stroke.pointerId===event.pointerId){event.preventDefault();addPoint(p);}
    },true);
    host.addEventListener('pointerup',event=>{
      if(panGesture?.pointerId===event.pointerId){event.preventDefault();event.stopImmediatePropagation();endPan();return;}
      if(stroke?.pointerId!==event.pointerId)return;event.preventDefault();event.stopImmediatePropagation();addPoint(outputPoint(event),true);finishStroke(true);
    },true);
    host.addEventListener('pointercancel',cancelInteraction,true);host.addEventListener('lostpointercapture',()=>{if(stroke||panGesture)cancelInteraction();});
    host.addEventListener('pointerenter',()=>{hovering=true;});host.addEventListener('pointerleave',()=>{hovering=false;if(!stroke&&!panGesture){hideCursor();host.style.cursor='default';layer.batchDraw();}});
    host.addEventListener('wheel',event=>{
      if(!visible||disabled||!(event.ctrlKey||event.metaKey)||stroke||action||panGesture)return;event.preventDefault();
      const oldScale=frame.scaleX(),point=outputPoint(event),rect=host.getBoundingClientRect(),screen={x:event.clientX-rect.left,y:event.clientY-rect.top};zoomMode='custom';zoomScale=clamp(oldScale*Math.exp(-event.deltaY*.002),.1,4);
      panX=screen.x-point.x*zoomScale-(host.clientWidth-result.width*zoomScale)/2;panY=screen.y-point.y*zoomScale-(host.clientHeight-result.height*zoomScale)/2;resize();
    },{passive:false});
    window.addEventListener('keydown',event=>{if(event.code!=='Space'||event.repeat||isEditable(event.target)||!visible||disabled||(!hovering&&!host.contains(document.activeElement)))return;event.preventDefault();cancelInteraction();spaceHeld=true;updateInteractionMode();});
    window.addEventListener('keyup',event=>{if(event.code!=='Space'||!spaceHeld)return;event.preventDefault();spaceHeld=false;endPan();updateInteractionMode();});
    window.addEventListener('blur',()=>{spaceHeld=false;cancelInteraction();updateInteractionMode();});window.addEventListener('pointercancel',cancelInteraction);
    const endOutside=()=>setTimeout(()=>{if(!action)return;const current=action;if(current.node===logo)commitLogo();else commitShoe(current.transform);},0);
    window.addEventListener('mouseup',endOutside);window.addEventListener('touchend',endOutside);
    host.addEventListener('keydown',event=>{
      if(event.key==='Escape'){spaceHeld=false;cancelInteraction();deselect();updateInteractionMode();return;}
      if(disabled||brush.mode!=='move'||!chosen||!result||spaceHeld||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
      event.preventDefault();const node=chosen==='logo'?logo:shoe,step=event.shiftKey?10:1;
      if(event.key==='ArrowLeft')node.x(node.x()-step);if(event.key==='ArrowRight')node.x(node.x()+step);if(event.key==='ArrowUp')node.y(node.y()-step);if(event.key==='ArrowDown')node.y(node.y()+step);
      chosen==='logo'?commitLogo():commitShoe(false);
    });observer=new ResizeObserver(resize);observer.observe(host);hide();
  }
  async function show(nextResult,nextSettings={}){
    if(!stage||!nextResult?.patchCanvas){hide();return false;}visible=true;host.hidden=false;if(result===nextResult){resize();return true;}
    const newPhoto=nextSettings._photoId!==undefined&&nextSettings._photoId!==settings?._photoId;
    cancelInteraction();const ticket=++generation;result=nextResult;previewResult=null;settings={...nextSettings};if(newPhoto){zoomMode='fit';panX=panY=0;}
    background.size({width:result.width,height:result.height});background.fill(settings.background);
    const clip={x:0,y:0,width:result.width,height:result.height};content.clip(clip);overlay.clip(clip);patch.image(result.patchCanvas);shoe.visible(true);resetGeometry();logo.visible(false);transformer.nodes([]);resize();
    if(result.logoPlacement&&settings.logoEnabled!==false){try{const asset=await GrayAssets.getLogo(settings.logoId||'default');if(ticket!==generation||!visible)return false;const l=result.logoPlacement;logo.setAttrs({image:asset.image,x:l.x,y:l.y,width:l.width,height:l.height,scaleX:1,scaleY:1,rotation:0,opacity:settings.logoOpacity??1,visible:true});}catch{if(ticket!==generation)return false;}}
    if(chosen&&!disabled)select(chosen);layer.batchDraw();return true;
  }
  function hide(){cancelInteraction();generation++;visible=false;result=null;previewResult=null;if(host)host.hidden=true;deselect();}
  function setDisabled(value){const next=!!value;if(next&&interacting)cancelInteraction();disabled=next;updateInteractionMode();}
  window.GrayEditor=Object.freeze({mount,show,showPreview,hide,setDisabled,setBrush,setZoom,select,deselect,isInteracting:()=>interacting});
})();
