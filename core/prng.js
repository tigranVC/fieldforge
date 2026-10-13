// Deterministic seeded PRNG (string/number seed -> 32-bit hash -> mulberry32).
// Same seed always yields the same sequence on every JS engine.

export function hashSeed(seed) {
  const s = String(seed);
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

export class Rng {
  constructor(seed) {
    this.s = hashSeed(seed);
  }
  /** float in [0, 1) */
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** integer in [min, max] inclusive */
  int(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  range(min, max) {
    return min + this.next() * (max - min);
  }
  chance(p) {
    return this.next() < p;
  }
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }
  /** pairs: [[value, weight], ...] */
  weighted(pairs) {
    const total = pairs.reduce((a, p) => a + p[1], 0);
    let r = this.next() * total;
    for (const [v, w] of pairs) {
      r -= w;
      if (r < 0) return v;
    }
    return pairs[pairs.length - 1][0];
  }
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}
