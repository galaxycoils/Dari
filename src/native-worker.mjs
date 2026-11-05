import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { signal, checkWork, phase, work } from './work.mjs';

const LIMIT = 64 * 1024 * 1024;
// Each instance belongs to one Devices session; Coordination serializes callers.
export class NativeWorker {
  constructor(file, device, { idleMs = 30000, args = [], env = process.env } = {}) {
    this.generation = randomUUID(); this.idleMs = idleMs;
    this.child = spawn(file, [...args, '--udid', device, '--worker'], { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env });
    this.pending = new Map(); this.chunks = []; this.bufferedBytes = 0;
    this.done = new Promise(resolve => this.child.once('close', () => { this.exited = true; clearTimeout(this.escalation); this.fail(new Error('Native worker exited; dispatched action outcome is unknown.')); resolve(); }));
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.stderr.resume(); // Never accumulate device diagnostics or private contents.
    this.child.stdout.on('data', chunk => {
      if (this.closed) return;
      while (chunk.length) {
        const end = chunk.indexOf(10);
        const part = end < 0 ? chunk : chunk.subarray(0, end);
        this.bufferedBytes += part.length;
        if (this.bufferedBytes > LIMIT) return this.fail(new Error('Native worker response exceeded 64 MiB'));
        this.chunks.push(part);
        if (end < 0) break;
        const line = Buffer.concat(this.chunks, this.bufferedBytes);
        this.chunks = []; this.bufferedBytes = 0;
        chunk = chunk.subarray(end + 1);
        let reply;
        try { reply = JSON.parse(line); } catch { return this.fail(new Error('Malformed native worker response')); }
        if (!reply || typeof reply !== 'object' || typeof reply.id !== 'string'
            || (typeof reply.error !== 'string' && (!reply.result || typeof reply.result !== 'object' || Array.isArray(reply.result)))) {
          return this.fail(new Error('Invalid native worker response envelope'));
        }
        const pending = this.pending.get(reply.id);
        if (!pending) return this.fail(new Error('Unexpected native worker response ID'));
        this.pending.delete(reply.id);
        if (reply.error) pending.reject(new Error(reply.error)); else pending.resolve(reply);
      }
    });
  }
  kill(sig) { try { if (this.child.pid) process.kill(-this.child.pid, sig); } catch (e) { if (e.code !== 'ESRCH') this.child.kill(sig); } }
  fail(error) {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.idle);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear(); this.chunks = []; this.bufferedBytes = 0;
    if (!this.exited) {
      this.child.stdin.end(); this.kill('SIGTERM');
      this.escalation = setTimeout(() => this.kill('SIGKILL'), 1000); this.escalation.unref();
    }
  }
  async call(request, { requestSignal = signal(), timeout = 95000 } = {}) {
    checkWork(); requestSignal?.throwIfAborted();
    if (this.closed || this.pending.size) throw new Error('Native worker unavailable or busy');
    const id = randomUUID();
    const message = JSON.stringify({ id, request }) + '\n';
    if (Buffer.byteLength(message) > 2 * 1024 * 1024) throw new Error('Native request exceeds 2 MiB; nothing sent');
    clearTimeout(this.idle);
    return phase('native_worker', async () => {
      const abort = () => this.fail(requestSignal.reason);
      const timer = setTimeout(() => this.fail(new DOMException('Native worker deadline exceeded', 'TimeoutError')), timeout);
      requestSignal?.addEventListener('abort', abort, { once: true });
      try {
        const result = await new Promise((resolve, reject) => {
          this.pending.set(id, { resolve, reject });
          this.child.stdin.write(message);
        });
        checkWork();
        const context = work.getStore();
        if (context?.timings && Number.isFinite(result.elapsed_ms)) context.timings.push({ id: context.timings.length, phase: 'native_execution', parent: context.phase ?? null, elapsed_ms: result.elapsed_ms });
        return result.result;
      } catch (error) {
        // A service error may have poisoned framing/state. No action is replayed.
        this.fail(error); await this.done; throw error;
      } finally {
        clearTimeout(timer); requestSignal?.removeEventListener('abort', abort);
        if (!this.closed) { this.idle = setTimeout(() => void this.close(), this.idleMs); this.idle.unref(); }
      }
    });
  }
  async close() { this.fail(new Error('Native worker closed')); await this.done; }
}
