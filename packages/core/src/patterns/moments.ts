import { decodeYarnId, type WeaveMaps } from './bake.ts';
import { octDecode } from './octahedral.ts';
import { YarnKind } from './weave.ts';

/**
 * One mip level of the specular table. Values are coverage-normalised tangent second moments
 * M = E[t t^T] over the texel footprint (yarn texels only):
 * - `a` RGBA: Mxx, Myy, Mxy, coverage (fraction of the footprint that is yarn)
 * - `b` RGBA: Mxz, Myz, 0, 0
 * Mzz = 1 - Mxx - Myy, because the trace of M is 1.
 */
export interface MomentLevel {
  size: number;
  a: Float32Array;
  b: Float32Array;
}

/**
 * Builds the default-tier specular table: the tangent second moment, box-filtered down a full
 * mip chain. Because the SGGX matrix is linear in M, filtering M is exact for the averaged
 * distribution, and roughness stays a runtime parameter.
 */
export function bakeMomentMips(maps: WeaveMaps): MomentLevel[] {
  const { size } = maps;
  if ((size & (size - 1)) !== 0) throw new RangeError(`Moment mips need a power-of-two size, got ${size}`);

  // Coverage-weighted sums: [xx, yy, xy, cov, xz, yz] per texel.
  let sums = new Float64Array(size * size * 6);
  for (let i = 0; i < size * size; i++) {
    if (maps.relief[i * 4 + 2]! > 127) continue;
    const [x, y, z] = octDecode([maps.weave[i * 4]!, maps.weave[i * 4 + 1]!]);
    const o = i * 6;
    sums[o] = x * x;
    sums[o + 1] = y * y;
    sums[o + 2] = x * y;
    sums[o + 3] = 1;
    sums[o + 4] = x * z;
    sums[o + 5] = y * z;
  }

  const levels: MomentLevel[] = [];
  let n = size;
  for (;;) {
    const a = new Float32Array(n * n * 4);
    const b = new Float32Array(n * n * 4);
    for (let i = 0; i < n * n; i++) {
      const o = i * 6;
      const cov = sums[o + 3]!;
      const texels = (size / n) * (size / n);
      a[i * 4 + 3] = cov / texels;
      if (cov > 0) {
        a[i * 4] = sums[o]! / cov;
        a[i * 4 + 1] = sums[o + 1]! / cov;
        a[i * 4 + 2] = sums[o + 2]! / cov;
        b[i * 4] = sums[o + 4]! / cov;
        b[i * 4 + 1] = sums[o + 5]! / cov;
      }
    }
    levels.push({ size: n, a, b });
    if (n === 1) break;
    const m = n / 2;
    const next = new Float64Array(m * m * 6);
    for (let y = 0; y < m; y++) {
      for (let x = 0; x < m; x++) {
        const d = (y * m + x) * 6;
        for (const [sx, sy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
          const s = ((y * 2 + sy) * n + (x * 2 + sx)) * 6;
          for (let k = 0; k < 6; k++) next[d + k]! += sums[s + k]!;
        }
      }
    }
    sums = next;
    n = m;
  }
  return levels;
}

/**
 * One mip level of the quality-tier table: two lobes per texel, each with its own
 * coverage-normalised tangent moment, so a pixel that covers both warp and weft keeps a
 * two-peaked highlight instead of one averaged blob (the failure case of the default tier).
 * - `a` RGBA: lobe 0 Mxx, Myy, Mxy, coverage
 * - `b` RGBA: lobe 0 Mxz, Myz, lobe 1 Mxz, Myz
 * - `c` RGBA: lobe 1 Mxx, Myy, Mxy, coverage
 *
 * Woven: lobe 0 is warp, lobe 1 weft. Knitted: the two loop legs lean opposite ways, so the
 * lobes split by the sign of tx * ty. This is a closed-form stand-in for Yang et al.'s fitted
 * two-lobe SGGX mixture: the split is known from the pattern, so no optimisation is needed.
 */
export interface TwoLobeLevel {
  size: number;
  a: Float32Array;
  b: Float32Array;
  c: Float32Array;
}

export function bakeTwoLobeMips(maps: WeaveMaps): TwoLobeLevel[] {
  const { size } = maps;
  if ((size & (size - 1)) !== 0) throw new RangeError(`Moment mips need a power-of-two size, got ${size}`);

  // Per texel, per lobe: [xx, yy, xy, cov, xz, yz].
  const K = 12;
  let sums = new Float64Array(size * size * K);
  for (let i = 0; i < size * size; i++) {
    const gap = maps.relief[i * 4 + 2]!;
    if (gap > 127) continue;
    const [x, y, z] = octDecode([maps.weave[i * 4]!, maps.weave[i * 4 + 1]!]);
    const lobe = maps.knitted ? (x * y < 0 ? 1 : 0) : decodeYarnId(maps.relief[i * 4 + 3]!, gap).kind === YarnKind.Weft ? 1 : 0;
    const o = i * K + lobe * 6;
    sums[o] = x * x;
    sums[o + 1] = y * y;
    sums[o + 2] = x * y;
    sums[o + 3] = 1;
    sums[o + 4] = x * z;
    sums[o + 5] = y * z;
  }

  const levels: TwoLobeLevel[] = [];
  let n = size;
  for (;;) {
    const a = new Float32Array(n * n * 4);
    const b = new Float32Array(n * n * 4);
    const c = new Float32Array(n * n * 4);
    const texels = (size / n) * (size / n);
    for (let i = 0; i < n * n; i++) {
      for (let lobe = 0; lobe < 2; lobe++) {
        const o = i * K + lobe * 6;
        const cov = sums[o + 3]!;
        const target = lobe === 0 ? a : c;
        target[i * 4 + 3] = cov / texels;
        if (cov > 0) {
          target[i * 4] = sums[o]! / cov;
          target[i * 4 + 1] = sums[o + 1]! / cov;
          target[i * 4 + 2] = sums[o + 2]! / cov;
          b[i * 4 + lobe * 2] = sums[o + 4]! / cov;
          b[i * 4 + lobe * 2 + 1] = sums[o + 5]! / cov;
        }
      }
    }
    levels.push({ size: n, a, b, c });
    if (n === 1) break;
    const m = n / 2;
    const next = new Float64Array(m * m * K);
    for (let y = 0; y < m; y++) {
      for (let x = 0; x < m; x++) {
        const d = (y * m + x) * K;
        for (const [sx, sy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
          const s = ((y * 2 + sy) * n + (x * 2 + sx)) * K;
          for (let k = 0; k < K; k++) next[d + k]! += sums[s + k]!;
        }
      }
    }
    sums = next;
    n = m;
  }
  return levels;
}
