/** IEEE 754 half-precision conversion, so assets can store float maps at half size. */
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

export function toHalf(value: number): number {
  f32[0] = value;
  const x = u32[0]!;
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let half = mant >>> shift;
    if ((mant >>> (shift - 1)) & 1 && ((mant & ((1 << (shift - 1)) - 1)) || half & 1)) half++;
    return sign | half;
  }
  let half = (e << 10) | (mant >>> 13);
  if (mant & 0x1000 && (mant & 0xfff || half & 1)) half++;
  return sign | half;
}

export function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

export function packHalf(values: Float32Array): Uint16Array {
  const out = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = toHalf(values[i]!);
  return out;
}

export function unpackHalf(values: Uint16Array): Float32Array {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = fromHalf(values[i]!);
  return out;
}
