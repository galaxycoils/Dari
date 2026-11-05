#!/usr/bin/env node
// Explicitly targets the disposable fixture; never submits into personal apps.
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdir, readFile, appendFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { hostname, platform, arch, release } from 'node:os';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { summarize } from './benchmark-report.mjs';
const args=process.argv.slice(2), option=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
if (args.includes('--help')) {
 console.log('node bin/benchmark-physical.mjs --baseline /original/poki --device UUID --out /private/results --confirm-fixture [--repeats 30] [--stress 300]');process.exit(0);
}
if(platform()!=='darwin'||!args.includes('--confirm-fixture')||!option('--device')||!option('--baseline')||!option('--out')) throw new Error('Requires macOS, a prepared phone, signed local.pokimcp.fixture app, --baseline, --device, --out and --confirm-fixture. See docs/optimization.md.');
const device=option('--device'), out=resolve(option('--out')), repeats=Number(option('--repeats',30)), stress=Number(option('--stress',300));
if(!Number.isSafeInteger(repeats)||repeats<1||!Number.isSafeInteger(stress)||stress<0) throw new Error('Invalid trial counts');
const original=resolve(option('--baseline')), candidate=resolve(import.meta.dirname,'..');
const revision=execFileSync('git',['-C',original,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(revision!=='8e740128a272709504fd57fd638de4df1a048976'||execFileSync('git',['-C',original,'status','--porcelain'],{encoding:'utf8'}).trim()) throw new Error('Baseline must be a clean checkout of pinned upstream commit');
await mkdir(out,{recursive:true,mode:0o700});
await writeFile(join(out,'metadata.json'),JSON.stringify({at:new Date().toISOString(),host:hostname(),platform:platform(),arch:arch(),release:release(),baseline:revision,candidate:execFileSync('git',['-C',candidate,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),device,repeats,stress,limitations:'Device-tool benchmarks only; model/learned-route/channel acceptance is separate.'},null,2),{flag:'wx',mode:0o600});
const lanes=[];const rows=[];const bundle_id='local.pokimcp.fixture';
function data(result){for(const c of result.content??[])if(c.type==='text'){try{return JSON.parse(c.text)}catch{}}return {};}
async function start(root,mode){
 const state=join(out,mode),env={...process.env,POKI_MCP_STATE_DIR:state,POKI_MCP_EXECUTION_MODE:mode,POKI_MCP_TOOLS:'all'};
 const daemon=spawn(process.execPath,[join(root,'src/daemon.mjs'),'--port','0'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
 const exit=once(daemon,'exit');daemon.stderr.resume();const lines=createInterface({input:daemon.stdout});
 let timer;try{await Promise.race([once(lines,'line'),exit.then(()=>{throw new Error('Daemon exited before readiness')}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Daemon readiness timeout')),30000)})]);}catch(error){daemon.kill();throw error}finally{clearTimeout(timer);lines.close();}
 const client=new Client({name:'poki-benchmark',version:'1'});
 const lane={mode,daemon,exit,client};lanes.push(lane);
 await client.connect(new StdioClientTransport({command:process.execPath,args:[join(root,'src/stdio.mjs')],env,stderr:'ignore'}));
 return lane;
}
async function call(lane,name,parameters={}){
 const callStarted=performance.now();
 const result=await lane.client.callTool({name,arguments:{device,...parameters}},{timeout:190000});
 lane.calls?.push({name,milliseconds:performance.now()-callStarted,timing:result._meta?.timing});
 if(result.isError)throw new Error(`${name} failed: ${data(result).stop_reason??'unverified'}`);return result;
}
async function observation(lane){return data(await call(lane,'list_elements'));}
const texts=o=>o.elements.flatMap(e=>[e.label,e.value,e.text].filter(v=>typeof v==='string'));
const tests={
 read:async lane=>{const o=await observation(lane);if(!texts(o).includes('Count: 0'))throw new Error('counter reset not verified');},
 tap:async lane=>{await call(lane,'tap_text',{text:'Increment',exact:true});if(!texts(await observation(lane)).includes('Count: 1'))throw new Error('counter increment not verified');},
 fill:async(lane,text)=>{await call(lane,'fill',{field:'Test text',text,submit:false});if(!texts(await observation(lane)).includes(text))throw new Error('field contents not verified');},
 batch:async lane=>{await call(lane,'batch_commands',{commands:[{tool:'tap_text',arguments:{text:'Increment',exact:true}},{tool:'fill',arguments:{field:'Test text',text:'Batch fixture',submit:false}}]});const t=texts(await observation(lane));if(!t.includes('Count: 1')||!t.includes('Batch fixture'))throw new Error('batch result not verified');},
 scroll:async lane=>{await call(lane,'scroll_to',{text:'Bottom target',exact:true});if(!texts(await observation(lane)).includes('Bottom target'))throw new Error('scroll target not verified');},
 recording:async lane=>{await call(lane,'start_recording');try{await tests.tap(lane);}finally{const r=data(await call(lane,'stop_recording'));if(!(r.bytes>0))throw new Error('recording empty');}},
};
async function trial(lane,name,index,phase){
 // Reset is deliberately outside the measured section and must succeed.
 await call(lane,'terminate_app',{bundle_id});await call(lane,'launch_app',{bundle_id});
 if(!texts(await observation(lane)).includes('Count: 0'))throw new Error('Fixture did not reset; benchmark stopped');
 lane.calls=[];lane.callAt=performance.now();const start=performance.now();let success=true,error;
 try{if(name.startsWith('fill-'))await tests.fill(lane,{'fill-ascii':'Fixture text','fill-chinese':'中文测试','fill-emoji':'Hello 👋🏽'}[name]);else await tests[name](lane);}catch(e){success=false;error=e.message;}
 const row={mode:lane.mode,task:name,index,phase,success,milliseconds:performance.now()-start,calls:lane.calls,error};lane.calls=undefined;rows.push(row);
 await appendFile(join(out,'trials.jsonl'),JSON.stringify(row)+'\n',{mode:0o600});console.log(JSON.stringify({mode:row.mode,task:name,index,phase,success,milliseconds:Math.round(row.milliseconds)}));
 if(!success)throw new Error('Verification failed; benchmark stopped to avoid replaying an uncertain action');
}
try{
 const baseline=await start(original,'legacy'), optimized=await start(candidate,'optimized');
 await writeFile(join(out,'device.json'),JSON.stringify(data(await call(optimized,'get_device_info')),null,2),{mode:0o600});
 for(let i=0;i<repeats;i++)for(const name of ['read','tap','fill-ascii','fill-chinese','fill-emoji','batch','scroll','recording'])for(const lane of i%2?[optimized,baseline]:[baseline,optimized])await trial(lane,name,i,i===0?'cold':'warm');
 for(let i=0;i<stress;i++)for(const lane of i%2?[optimized,baseline]:[baseline,optimized])await trial(lane,'tap',i,'stress');
}finally{
 for(const lane of lanes){await lane.client.close().catch(()=>{});lane.daemon.kill('SIGTERM');await lane.exit;}
 await writeFile(join(out,'summary.json'),JSON.stringify(summarize(rows),null,2),{mode:0o600});
}
