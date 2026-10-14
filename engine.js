(() => {
 'use strict';
 globalThis.GrayEngine={
  async prepare(file,progress=()=>{}){
   const pixels=await GrayInference.preparePixels(file,progress);
   const prepared=await GrayProcessing.analyze(pixels);
   prepared.originalWidth=pixels.originalWidth;prepared.originalHeight=pixels.originalHeight;
   prepared.sourceBox=pixels.sourceBox;prepared.sourceFile=file;prepared.warnings=prepared.warnings||[];
   if(pixels.clipped)prepared.warnings.push('原图的鞋子接近画面边缘，请确认主体完整。');
   return prepared;
  },
  render:(prepared,settings)=>GrayProcessing.render(prepared,settings),
  renderLayers:(prepared,settings)=>GrayProcessing.renderLayers(prepared,settings),
  preview:(prepared,settings)=>GrayProcessing.preview(prepared,settings)
 };
})();
