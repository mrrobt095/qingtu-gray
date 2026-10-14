'use strict';
const {parentPort}=require('worker_threads'),path=require('path'),os=require('os');
const ort=require('./runtime/node_modules/onnxruntime-node');
// Load the model as soon as the worker starts; one thread per physical core (half the logical ones), 4 to 8.
const threads=Math.max(4,Math.min(8,Math.floor((os.availableParallelism?.()||os.cpus().length)/2)));
const sessionReady=ort.InferenceSession.create(path.join(__dirname,'models/birefnet-tiny.onnx'),{executionProviders:['cpu'],intraOpNumThreads:threads,interOpNumThreads:1,graphOptimizationLevel:'all',enableCpuMemArena:false,enableMemPattern:false});
sessionReady.catch(()=>{});
parentPort.on('message',async({id,rgba})=>{
 try{
  const session=await sessionReady;
  const n=1024*1024,data=new Float32Array(3*n),mean=[.485,.456,.406],std=[.229,.224,.225];
  for(let i=0;i<n;i++)for(let c=0;c<3;c++)data[c*n+i]=(rgba[4*i+c]/255-mean[c])/std[c];
  const input=new ort.Tensor('float32',data,[1,3,1024,1024]);
  const result=await session.run({[session.inputNames[0]]:input});
  const output=result[session.outputNames[0]],raw=output.data,mask=new Float32Array(n);
  for(let i=0;i<n;i++)mask[i]=1/(1+Math.exp(-raw[i]));
  input.dispose();for(const t of Object.values(result))t.dispose();
  parentPort.postMessage({id,mask},[mask.buffer]);
 }catch(e){parentPort.postMessage({id,error:e.message||String(e)});}
});
