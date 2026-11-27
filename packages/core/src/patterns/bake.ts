import { octDecode, octEncode, type Vec3 } from './octahedral.ts';
import { knitAspect, knitSampler, maxKnitHeight, type KnitParams, type KnitPattern } from './knit.ts';
import { maxWeaveHeight, sampleWeave, YarnKind, yarnNormal, type WeaveParams, type WeavePattern, type WeaveSample } from './weave.ts';

/**
 * Maps for one pattern repeat, `size` x `size` texels, row-major from v = 0.
 * The repeat is `aspect` times wider than tall physically; scale UVs by it.
 *
 * - `weave` (RGBA float): R,G = octahedral yarn tangent, B = across-yarn h mapped to 0..1,
 *   A = along-yarn z as a fraction of the repeat.
 * - `relief` (RGBA8): R = height, G = ambient occlusion, B = gap mask (255 = no yarn),
 *   A = yarn id * 2 + (1 if weft), so the shader can recover both. Knits store course * 2.
 * - `horizon` (RGBA8): sine of the horizon's elevation seen from each texel toward +u, -u, +v
 *   and -v (0 = open sky, 255 = straight up), within one yarn cell. A light lower than the
 *   horizon in its direction is shadowed by the neighbouring yarns.
 * - `normal` (RGBA8): RGB = yarn shading normal in fabric space mapped to 0..255, A = 255.
 *   Box-filtered mips of it average toward the macro normal, which is how Yang et al. (2026)
 *   prefilter their yarn-normal diffuse term.
 */
export interface WeaveMaps {
  size: number;
  /** Physical width / height of the repeat. */
  aspect: number;
  knitted: boolean;
  weave: Float32Array;
  relief: Uint8Array;
  /** Absent in files written before yarn normals existed; see {@link deriveYarnNormals}. */
  normal?: Uint8Array;
  /** Absent in files written before self-shadowing existed; the material then skips it. */
  horizon?: Uint8Array;
}

export interface BakeOptions {
  /** Texels per side of the repeat. */
  size: number;
  /** Ambient occlusion strength, 0..1. */
  aoStrength: number;
}

export const defaultBakeOptions: BakeOptions = { size: 256, aoStrength: 0.6 };

function boxBlur(src: Float32Array, size: number, radius: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const n = radius * 2 + 1;
  const wrap = (i: number) => ((i % size) + size) % size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += src[y * size + wrap(x + k)]!;
      tmp[y * size + x] = s / n;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += tmp[wrap(y + k) * size + x]!;
      out[y * size + x] = s / n;
    }
  }
  return out;
}

interface BakeSource {
  sample: (u: number, v: number) => WeaveSample;
  maxHeight: number;
  /** Cells along the longer side, used to size the occlusion blur. */
  cells: number;
  /** Repeat size along u and v in the sampler's height units. */
  extent: [number, number];
  /** Cells along u and v, to bound the horizon search to about one cell. */
  grid: [number, number];
  aspect: number;
  knitted: boolean;
}

function bake(src: BakeSource, options: BakeOptions): WeaveMaps {
  const { size } = options;
  if (!Number.isInteger(size) || size < 8 || size > 4096) throw new RangeError(`Bake size must be an integer 8..4096, got ${size}`);

  const weave = new Float32Array(size * size * 4);
  const relief = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const surface = new Float32Array(size * size);
  const hMax = src.maxHeight;

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const s = src.sample(u, v);
      const i = y * size + x;
      const [ox, oy] = octEncode(s.tangent);
      weave[i * 4 + 0] = ox;
      weave[i * 4 + 1] = oy;
      weave[i * 4 + 2] = s.h * 0.5 + 0.5;
      weave[i * 4 + 3] = s.z;
      const h01 = Math.min(1, Math.max(0, 0.5 + s.height / (2 * hMax)));
      height[i] = h01;
      surface[i] = s.height;
      relief[i * 4 + 0] = Math.round(h01 * 255);
      relief[i * 4 + 2] = s.kind === YarnKind.None ? 255 : 0;
      relief[i * 4 + 3] = s.kind === YarnKind.None ? 0 : s.yarnId * 2 + (s.kind === YarnKind.Weft ? 1 : 0);
      encodeNormal(normal, i, s.normal);
    }
  }

  // Cheap cavity occlusion: texels below their neighbourhood average are darkened.
  const radius = Math.max(1, Math.round(size / src.cells / 4));
  const blurred = boxBlur(height, size, radius);
  for (let i = 0; i < size * size; i++) {
    const cavity = Math.max(0, blurred[i]! - height[i]!) * 4;
    relief[i * 4 + 1] = Math.round(255 * Math.max(0, 1 - options.aoStrength * Math.min(1, cavity)));
  }

  return { size, aspect: src.aspect, knitted: src.knitted, weave, relief, normal, horizon: horizonMap(surface, size, src.extent, src.grid) };
}

export function bakeWeaveMaps(pattern: WeavePattern, params: WeaveParams, options: BakeOptions = defaultBakeOptions): WeaveMaps {
  return bake(
    {
      sample: (u, v) => sampleWeave(pattern, params, u, v),
      maxHeight: maxWeaveHeight(params),
      cells: Math.max(pattern.rows, pattern.cols),
      extent: [pattern.cols, pattern.rows],
      grid: [pattern.cols, pattern.rows],
      aspect: pattern.cols / pattern.rows,
      knitted: false,
    },
    options,
  );
}

export function bakeKnitMaps(pattern: KnitPattern, params: KnitParams, options: BakeOptions = defaultBakeOptions): WeaveMaps {
  return bake(
    {
      sample: knitSampler(pattern, params),
      maxHeight: maxKnitHeight(params),
      cells: Math.max(pattern.rows, pattern.cols),
      extent: [pattern.cols * params.stitchAspect, pattern.rows],
      grid: [pattern.cols, pattern.rows],
      aspect: knitAspect(pattern, params),
      knitted: true,
    },
    options,
  );
}

/** Decode the yarn id and kind stored in a relief texel's alpha. */
export function decodeYarnId(alpha: number, gap: number, knitted = false): { kind: YarnKind; yarnId: number } {
  if (gap > 127) return { kind: YarnKind.None, yarnId: 0 };
  if (knitted) return { kind: YarnKind.Loop, yarnId: alpha >> 1 };
  return { kind: alpha & 1 ? YarnKind.Weft : YarnKind.Warp, yarnId: alpha >> 1 };
}

function encodeNormal(out: Uint8Array, i: number, n: Vec3): void {
  out[i * 4] = Math.round((n[0] * 0.5 + 0.5) * 255);
  out[i * 4 + 1] = Math.round((n[1] * 0.5 + 0.5) * 255);
  out[i * 4 + 2] = Math.round((n[2] * 0.5 + 0.5) * 255);
  out[i * 4 + 3] = 255;
}

/**
 * Yarn normals rebuilt from the weave and relief maps, for files saved before the baker wrote
 * them. The cross-section's flatness is not stored, so yarns are taken as round.
 */
export function deriveYarnNormals(maps: WeaveMaps): Uint8Array {
  const n = maps.size * maps.size;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const { kind } = decodeYarnId(maps.relief[i * 4 + 3]!, maps.relief[i * 4 + 2]!, maps.knitted);
    if (kind === YarnKind.None) {
      encodeNormal(out, i, [0, 0, 1]);
      continue;
    }
    const t = octDecode([maps.weave[i * 4]!, maps.weave[i * 4 + 1]!]);
    const h = maps.weave[i * 4 + 2]! * 2 - 1;
    // Same across directions as the samplers: +u for warp, +v for weft, left of the yarn for knits.
    const pl = Math.hypot(t[0], t[1]) || 1;
    const across: Vec3 = kind === YarnKind.Warp ? [1, 0, 0] : kind === YarnKind.Weft ? [0, 1, 0] : [-t[1] / pl, t[0] / pl, 0];
    encodeNormal(out, i, yarnNormal(t, across, h, 1));
  }
  return out;
}

/**
 * Horizon per texel toward +u, -u, +v and -v: the highest elevation angle at which the height
 * field rises within one cell in that direction, stored as its sine. Heights and the repeat
 * extent are in the same units, so the angles are physical.
 */
export function horizonMap(height: Float32Array, size: number, extent: [number, number], grid: [number, number]): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const sines = [0, 1, 2, 3].map(() => new Float32Array(size * size));
  const wrap = (i: number) => ((i % size) + size) % size;
  const dirs: [number, number, number][] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 1],
    [0, -1, 1],
  ];
  const texel = [extent[0] / size, extent[1] / size];
  const reach = [Math.max(2, Math.round(size / grid[0])), Math.max(2, Math.round(size / grid[1]))];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const h0 = height[y * size + x]!;
      for (let d = 0; d < 4; d++) {
        const [dx, dy, axis] = dirs[d]!;
        let best = 0; // tan of the horizon elevation
        for (let k = 1; k <= reach[axis]!; k++) {
          const h = height[wrap(y + dy * k) * size + wrap(x + dx * k)]!;
          best = Math.max(best, (h - h0) / (k * texel[axis]!));
        }
        sines[d]![y * size + x] = best / Math.hypot(1, best);
      }
    }
  }
  // Yarn edges are steps in the height field, which leave thin fan-shaped streaks in the
  // horizons; a one-texel blur removes them without softening the shadows noticeably.
  for (let d = 0; d < 4; d++) {
    const smooth = boxBlur(sines[d]!, size, 1);
    for (let i = 0; i < size * size; i++) out[i * 4 + d] = Math.round(smooth[i]! * 255);
  }
  return out;
}
