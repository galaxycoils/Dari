import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
const binary = resolve(import.meta.dirname, '../native/bridge/target/debug/poki-native');
for (const scenario of ['idle termination', 'malformed request', 'oversized request']) {
 test(`compiled Rust worker: ${scenario}`, { skip: !existsSync(binary), timeout: 5000 }, async t => {
  // No valid device operation is sent; these cases exercise framing/lifecycle only.
  const child = spawn(binary, ['--udid','synthetic-no-device','--worker'], {stdio:['pipe','pipe','pipe']});
  const done = once(child,'exit');child.stdout.resume();child.stderr.resume();child.stdin.on('error',()=>{});
  const kill = setTimeout(()=>child.kill('SIGKILL'),3000);let stop;
  t.after(()=>{clearTimeout(kill);clearTimeout(stop);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  if(scenario==='idle termination') stop=setTimeout(()=>child.kill('SIGTERM'),100);
  else child.stdin.end(scenario==='malformed request'?'invalid JSON\n':'x'.repeat(2*1024*1024+1)+'\n');
  const [code, signal]=await done;assert.equal(signal,null);assert.equal(code,scenario==='idle termination'?0:1);
 });
}
