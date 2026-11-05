// Additive MCP receipts are evidence only when complete, fresh and device-scoped.
export function validReceiptObservation(result, device, now = Date.now()) {
  const value = result?.structuredContent?.observation;
  const o = value?.observation;
  if (result?.isError || !o || !Array.isArray(value.elements) || !value.elements.length || value.truncated || value.source !== 'accessibility'
      || typeof o.id !== 'string' || !o.id || typeof o.device !== 'string' || !o.device || !Number.isSafeInteger(o.revision) || o.revision < 0 || (device && o.device !== device)
      || !Number.isFinite(o.width) || o.width <= 0 || !Number.isFinite(o.height) || o.height <= 0
      || value.elements.some(e => !e || typeof e.ref !== 'string' || !/^e\d+$/.test(e.ref))
      || new Set(value.elements.map(e => e.ref)).size !== value.elements.length) return null;
  const structure = Date.parse(o.structure_completed_at);
  if (!Number.isFinite(structure) || now - structure > 5000 || structure > now + 1000) return null;
  const start = Date.parse(o.capture_started_at), end = Date.parse(o.capture_completed_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end > now + 1000 || start > now + 1000 || now - start > 5000) return null;
  return value;
}
