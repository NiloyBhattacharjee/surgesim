/** murmur3 32-bit finalizer: a strong integer mixer. */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Two independent 32-bit string hashes (FNV-1a and a multiplicative variant) = a 64-bit stream hash. */
function hashString(s: string): [number, number] {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b + c + 1, 0x5bd1e995);
    b ^= b >>> 15;
  }
  return [fmix32(a), fmix32(b ^ s.length)];
}

function splitSeed(seed: number): [number, number] {
  if (!Number.isFinite(seed)) throw new RangeError(`seed must be a finite number, got ${seed}`);
  const s = Math.abs(Math.trunc(seed));
  return [s >>> 0, Math.floor(s / 4294967296) >>> 0];
}

/**
 * Derive a child seed from a base seed and an index (e.g. replication number).
 * The result is a non-negative integer below 2^53.
 */
export function deriveSeed(baseSeed: number, index: number): number {
  const [lo, hi] = splitSeed(baseSeed);
  const [ilo, ihi] = splitSeed(index);
  const a = fmix32(lo ^ fmix32(ilo + 0x9e3779b9));
  const b = fmix32(hi ^ fmix32(ihi + 0x7f4a7c15) ^ a);
  const c = fmix32(a + b + 0x165667b1);
  return (c & 0x1fffff) * 4294967296 + fmix32(a ^ (b + 0x27d4eb2f));
}

function splitmix32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
}

/**
 * Seeded pseudo-random number generator (xoshiro128**, 128-bit state).
 *
 * A generator is identified by `(seed, streamId)`: the same pair always yields the same sequence,
 * and different stream ids yield statistically independent sequences. Give every component its
 * own stream so that changing one component never shifts another component's random numbers.
 */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number, streamId: string | number = 0) {
    const [lo, hi] = splitSeed(seed);
    const [h1, h2] = hashString(String(streamId));
    const g1 = splitmix32(fmix32(lo ^ fmix32(h1)));
    const g2 = splitmix32(fmix32(hi + 0x632be5ab) ^ fmix32(h2 + 0x1b873593) ^ g1());
    this.s0 = g1();
    this.s1 = g1();
    this.s2 = g2();
    this.s3 = g2();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** Next uniformly distributed unsigned 32-bit integer. */
  nextUint32(): number {
    const { s1 } = this;
    const x = Math.imul(s1, 5);
    const result = Math.imul((x << 7) | (x >>> 25), 9) >>> 0;
    const t = s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = (this.s3 << 11) | (this.s3 >>> 21);
    return result;
  }

  /** Next uniform float in [0, 1) with 53 bits of resolution. */
  nextFloat(): number {
    const a = this.nextUint32() >>> 5; // 27 bits
    const b = this.nextUint32() >>> 6; // 26 bits
    return (a * 67108864 + b) / 9007199254740992;
  }

  /** Next uniform float in (0, 1] — safe as an argument to Math.log. */
  nextFloatOpen(): number {
    return 1 - this.nextFloat();
  }
}
