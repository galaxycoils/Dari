// Bounded derived-image/OCR reuse. Exact pixel hashes never authorize stale refs.
export class FrameCache {
  constructor({ maxEntries = 2, maxBytes = 64 * 1024 * 1024 } = {}) {
    this.entries = new Map(); this.bytes = 0; this.maxEntries = maxEntries; this.maxBytes = maxBytes;
  }
  get(key) { const entry = this.entries.get(key); if (entry) { this.entries.delete(key); this.entries.set(key, entry); } return entry?.value; }
  find(predicate) {
    for (const [key, entry] of this.entries) if (predicate(entry.value)) return this.get(key);
  }
  set(key, value, bytes) {
    const old = this.entries.get(key);
    if (old) { this.bytes -= old.bytes; this.entries.delete(key); }
    if (bytes > this.maxBytes) return value;
    this.entries.set(key, { value, bytes }); this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const [oldest, entry] = this.entries.entries().next().value; this.bytes -= entry.bytes; this.entries.delete(oldest);
    }
    return value;
  }
  clear() { this.entries.clear(); this.bytes = 0; }
}
