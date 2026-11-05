#!/usr/bin/env node
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { FrameCache } from '../src/frame-cache.mjs';
import { prepareFrame, frameJpeg } from '../src/frame-processing.mjs';
const width=1170,height=2532,scale=3,rounds=40;
const pixels=Buffer.alloc(width*height*3);
for(let y=0;y<height;y++)for(let x=0;x<width;x++){
 const at=(y*width+x)*3,v=(x*13+y*7)%256;pixels[at]=v;pixels[at+1]=y%256;pixels[at+2]=x%256;
}
const original=await sharp(pixels,{raw:{width,height,channels:3}}).png().toBuffer();
const cache=new FrameCache();const {derived}=await prepareFrame(original,scale,'benchmark',cache);
await frameJpeg(derived,390,cache);
const previous=async()=>{
 const meta=await sharp(original).metadata();
 const w=Math.round(meta.width/scale),h=Math.round(meta.height/scale);
 const raw=await sharp(original).resize(w,h).ensureAlpha().raw().toBuffer();
 createHash('sha256').update(`${w}:${h}:`).update(raw).digest('hex');
 // Previous warm cache reused the PNG, but JPEG requests always encoded again.
 await sharp(derived.data).resize({width:390}).jpeg({quality:90}).toBuffer();
};
const improved=async()=>{const {derived}=await prepareFrame(original,scale,'benchmark',cache);await frameJpeg(derived,390,cache);};
for(let i=0;i<3;i++){await previous();await improved();}
const samples={previous:[],improved:[]};
for(let i=0;i<rounds;i++)for(const name of i%2?['improved','previous']:['previous','improved']){
 const start=performance.now();await ({previous,improved})[name]();samples[name].push(performance.now()-start);
}
const quantile=(a,q)=>a.toSorted((a,b)=>a-b)[Math.ceil(q*a.length)-1];
const summary=Object.fromEntries(Object.entries(samples).map(([name,a])=>[name,{p50_ms:quantile(a,.5),p95_ms:quantile(a,.95)}]));
console.log(JSON.stringify({environment:{platform:process.platform,arch:process.arch,node:process.version},scenario:'Identical lossless screenshots + same-width JPEG, warm cache; excludes capture, AX, OCR and model time',width,height,scale,rounds,source_bytes:original.length,summary,p50_speedup:summary.previous.p50_ms/summary.improved.p50_ms,samples},null,2));
