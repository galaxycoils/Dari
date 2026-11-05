import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { FrameCache } from '../src/frame-cache.mjs';
import { prepareFrame, frameJpeg, accountFrame } from '../src/frame-processing.mjs';
import { validReceiptObservation } from '../src/observation-receipt.mjs';
const original = await sharp({create:{width:120,height:240,channels:3,background:'#397cc1'}}).png().toBuffer();
test('identical captures bypass image processing while scale and worker changes invalidate reuse', async()=>{
 const cache=new FrameCache();
 const first=await prepareFrame(original,3,'one',cache);assert.equal(first.cacheHit,'none');assert.equal(first.derived.width,40);
 const second=await prepareFrame(original,3,'one',cache);assert.equal(second.cacheHit,'source');assert.equal(second.derived,first.derived);
 const resized=await prepareFrame(original,2,'one',cache);assert.equal(resized.derived.width,60);assert.notEqual(resized.derived,first.derived);
 const reconnected=await prepareFrame(original,2,'two',cache);assert.equal(reconnected.cacheHit,'none');assert.notEqual(reconnected.derived,resized.derived);
});
test('different lossless encodings of identical pixels share processed data',async()=>{
 const cache=new FrameCache();const a=await prepareFrame(original,1,'worker',cache);
 const encoded=await sharp(original).png({compressionLevel:0}).toBuffer();assert.notDeepEqual(original,encoded);
 const b=await prepareFrame(encoded,1,'worker',cache);assert.equal(b.cacheHit,'pixels');assert.equal(a.derived,b.derived);
 const changed=await sharp({create:{width:120,height:240,channels:3,background:'red'}}).png().toBuffer();
 assert.notEqual((await prepareFrame(changed,1,'worker',cache)).derived.pixelHash,a.derived.pixelHash);
});
test('JPEG variants reuse buffers and account for image, OCR and JPEG memory',async()=>{
 const cache=new FrameCache();const {derived}=await prepareFrame(original,1,'worker',cache);
 derived.ocrBytes=32;accountFrame(cache,derived);
 const a=await frameJpeg(derived,40,cache);assert.equal(a,await frameJpeg(derived,40,cache));
 const b=await frameJpeg(derived,80,cache);assert.notEqual(a,b);
 assert.equal(cache.bytes,derived.data.length+32+b.length);
 assert.equal((await sharp(b).metadata()).width,80);
});
test('oversized processed images remain available to the caller without entering the cache',async()=>{
 const cache=new FrameCache({maxBytes:1});const a=await prepareFrame(original,1,'worker',cache);
 assert.ok(a.derived.data.length>1);assert.equal(cache.entries.size,0);
 await frameJpeg(a.derived,40,cache);assert.equal(cache.bytes,0);
});
test('malformed receipt elements and future capture completion cannot be reused',()=>{
 const now=Date.now();const o={id:'o',device:'phone',revision:1,width:40,height:80,capture_started_at:new Date(now).toISOString(),capture_completed_at:new Date(now+2000).toISOString(),structure_completed_at:new Date(now).toISOString()};
 const receipt=elements=>({structuredContent:{observation:{source:'accessibility',elements,observation:o}}});
 for(const elements of [{length:1},[null],[{}],null,[]])assert.equal(validReceiptObservation(receipt(elements),'phone',now),null);
 assert.equal(validReceiptObservation(receipt([{ref:'e1'}]),'phone',now),null);
});
