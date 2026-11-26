import { createHash } from 'node:crypto';

/** 确定性伪随机数生成器（Mulberry32 变体），用于固定种子复现分配结果。 */
export function createPrng(seed: string): () => number {
  let s = 0;
  const h = createHash('sha256').update(seed).digest();
  for (let i = 0; i < 8; i++) {
    s = (s * 256 + h[i]) >>> 0;
  }
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(array: T[], seed: string): T[] {
  const rng = createPrng(seed);
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function sample<T>(array: T[], count: number, seed: string): T[] {
  const shuffled = shuffle(array, seed);
  return shuffled.slice(0, Math.max(0, Math.min(count, shuffled.length)));
}

export function pickOne<T>(array: T[], seed: string): T | undefined {
  if (array.length === 0) return undefined;
  const rng = createPrng(seed);
  return array[Math.floor(rng() * array.length)];
}
