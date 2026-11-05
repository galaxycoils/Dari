import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeWorker } from '../src/native-worker.mjs';
import { FrameCache } from '../src/frame-cache.mjs';
import { validReceiptObservation } from '../src/observation-receipt.mjs';
const program = `import {createInterface} from 'node:readline';
let count=0;for await(const line of createInterface({input:process.stdin})) {
 const {id,request}=JSON.parse(line);count++;
 if(request.op==='hang') await new Promise(()=>{});
 else if(request.op==='null_reply') console.log('null');
 else if(request.op==='missing_result') console.log(JSON.stringify({id}));
 else if(request.op==='malformed') console.log('bad json');
 else if(request.op==='disconnect') process.exit(0);
 else if(request.op==='wrong_id') console.log(JSON.stringify({id:'wrong',result:{}}));
 else console.log(JSON.stringify({id,result:{pid:process.pid,count}}));
}`;
function worker(t, options) { const w=new NativeWorker(process.execPath,'fixture',{args:['--input-type=module','-e',program,'--'],...options});t.after(()=>w.close());return w; }
test('persistent worker reuses one process and serializes framed replies',async t=>{
 const w=worker(t);const a=await w.call({op:'read'});const b=await w.call({op:'read'});
 assert.equal(a.pid,b.pid);assert.equal(b.count,2);
});
for(const op of ['malformed','disconnect','wrong_id','null_reply','missing_result']) test(`worker rejects ${op} without replay`,async t=>{
 const w=worker(t);await assert.rejects(w.call({op}));assert.equal(w.closed,true);await assert.rejects(w.call({op:'read'}));
});
test('cancelled worker closes before rejection allows device takeover',async t=>{
 const w=worker(t),controller=new AbortController();await w.call({op:'read'});
 const pending=w.call({op:'hang'},{requestSignal:controller.signal});controller.abort();await assert.rejects(pending);await w.done;assert.equal(w.child.exitCode!==null||w.child.signalCode!==null,true);
});
test('worker idle expiry and timeout terminate owned processes',async t=>{
 const w=worker(t,{idleMs:20});await w.call({op:'read'});await w.done;assert.equal(w.closed,true);
 const other=worker(t);await assert.rejects(other.call({op:'hang'},{timeout:30}),{name:'TimeoutError'});assert.equal(other.closed,true);
});
test('frame cache enforces byte/entry limits and LRU eviction',()=>{
 const cache=new FrameCache({maxEntries:2,maxBytes:10});cache.set('a',1,4);cache.set('b',2,4);cache.get('a');cache.set('c',3,4);assert.equal(cache.get('b'),undefined);assert.equal(cache.bytes,8);cache.set('large',4,11);assert.equal(cache.get('large'),undefined);cache.clear();assert.equal(cache.bytes,0);
});
test('only fresh complete device-scoped observations are accepted',()=>{
 const now=Date.now();const r={structuredContent:{observation:{source:'accessibility',elements:[{ref:'e1'}],observation:{id:'o',device:'phone',revision:1,width:402,height:874,structure_completed_at:new Date(now).toISOString(),capture_started_at:new Date(now-20).toISOString(),capture_completed_at:new Date(now).toISOString()}}}};
 assert.ok(validReceiptObservation(r,'phone',now));assert.equal(validReceiptObservation(r,'other',now),null);assert.equal(validReceiptObservation(r,'phone',now+6000),null);assert.equal(validReceiptObservation({...r,isError:true},'phone',now),null);
 r.structuredContent.observation.elements.push({ref:'e1'});assert.equal(validReceiptObservation(r,'phone',now),null);
});

test('optimized daemon publishes fresh receipts through the real stdio/HTTP bridge', {timeout:30000}, async t=>{
 const {fixture,value}=await import('./fixture.mjs');
 const f=await fixture(t,{executionMode:'optimized'});
 await f.set({label:'First',afterInput:{label:'Second'}});
 const result=await f.call('tap_text',{text:'First'});
 assert.equal(result.isError,undefined);
 const receipt=validReceiptObservation(result,'fixture-phone');assert.ok(receipt);
 assert.ok(receipt.elements.some(e=>e.label==='Second'));
 assert.ok(receipt.observation.worker_generation);
 assert.equal(value(result).sent,true);
 const next=await f.call('tap',{ref:receipt.elements[0].ref});assert.notEqual(next.isError,true);
 const events=await f.events();assert.equal(events.filter(e=>e.tool==='poki-native'&&e.args?.includes('--worker')).length,1);
 await f.call('cancel_device');
 const stale=await f.call('tap',{ref:receipt.elements[0].ref});assert.equal(stale.isError,true);
});

test('oversized requests are rejected before sending and leave the worker usable',async t=>{
 const w=worker(t);await assert.rejects(w.call({op:'read',text:'x'.repeat(2*1024*1024)}),/nothing sent/);
 const result=await w.call({op:'read'});assert.equal(result.count,1);
});
test('natural worker exit does not schedule termination of an exited process',async t=>{
 const w=worker(t);const kills=[];const kill=w.kill.bind(w);w.kill=sig=>{kills.push(sig);kill(sig);};
 await assert.rejects(w.call({op:'disconnect'}));assert.equal(w.exited,true);assert.deepEqual(kills,[]);assert.equal(w.bufferedBytes,0);assert.equal(w.chunks.length,0);
});
test('two MCP clients retire the previous physical worker before ownership changes', {timeout:30000}, async t=>{
 const {fixture,value}=await import('./fixture.mjs');const f=await fixture(t,{executionMode:'optimized'});
 const first=value(await f.call('list_elements'));const events=await f.events();
 const pid=events.find(e=>e.tool==='poki-native'&&e.args?.includes('--worker')).pid;
 const other=await f.connect();const next=await other.callTool({name:'list_elements',arguments:{}});assert.notEqual(next.isError,true);
 assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 const stale=await f.call('tap',{ref:first.elements[0].ref});assert.equal(stale.isError,true);
 assert.equal((await f.events()).filter(e=>e.op==='tap').length,0);
});
test('identical screenshots retain fresh capture identities while reusing OCR and avoiding temporary files', {timeout:30000}, async t=>{
 const {fixture,value}=await import('./fixture.mjs');const {stat}=await import('node:fs/promises');
 const f=await fixture(t,{executionMode:'optimized'});
 const a=await f.call('take_screenshot');const b=await f.call('take_screenshot');
 assert.notEqual(value(a).observation.id,value(b).observation.id);
 assert.equal(a.content.find(c=>c.type==='image').data,b.content.find(c=>c.type==='image').data);
 assert.equal((await f.events()).filter(e=>e.tool==='ocr').length,1);
 await assert.rejects(stat(f.dir+'/state/frames'),{code:'ENOENT'});
});
