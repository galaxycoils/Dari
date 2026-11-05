import sharp from 'sharp';
import { createHash } from 'node:crypto';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function accountFrame(cache, frame) {
  cache.set(frame.cacheKey, frame, frame.data.length + (frame.ocrBytes ?? 0) + (frame.jpeg?.data.length ?? 0));
}
// Cache image transformations only. Capture identity and accessibility refs are always new.
export async function prepareFrame(original, scale, generation, cache) {
  const sourceHash = hash(original);
  const exact = cache.find(frame => frame.sourceHash === sourceHash && frame.scale === scale && frame.generation === generation);
  if (exact) return { derived: exact, cacheHit: 'source' };
  const meta = await sharp(original).metadata();
  const width = Math.round(meta.width / scale), height = Math.round(meta.height / scale);
  const { data: pixels, info } = await sharp(original).resize(width, height).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixelHash = createHash('sha256').update(`${width}:${height}:`).update(pixels).digest('hex');
  const cacheKey = `${generation}:${pixelHash}`;
  let derived = cache.get(cacheKey);
  const cacheHit = derived ? 'pixels' : 'none';
  if (!derived) derived = { data: await sharp(pixels, { raw: info }).png().toBuffer(), pixelHash, cacheKey, width, height };
  Object.assign(derived, { sourceHash, scale, generation });
  accountFrame(cache, derived);
  return { derived, cacheHit };
}
export async function frameJpeg(frame, width, cache) {
  if (frame.jpeg?.width === width) return frame.jpeg.data;
  const data = await sharp(frame.data).resize({ width }).jpeg({ quality: 90 }).toBuffer();
  frame.jpeg = { width, data }; // One variant per frame keeps the cache bounded.
  accountFrame(cache, frame);
  return data;
}
