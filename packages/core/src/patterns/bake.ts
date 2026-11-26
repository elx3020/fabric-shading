import { octEncode } from './octahedral.ts';
import { knitAspect, knitSampler, maxKnitHeight, type KnitParams, type KnitPattern } from './knit.ts';
import { maxWeaveHeight, sampleWeave, YarnKind, type WeaveParams, type WeavePattern, type WeaveSample } from './weave.ts';

/**
 * Maps for one pattern repeat, `size` x `size` texels, row-major from v = 0.
 * The repeat is `aspect` times wider than tall physically; scale UVs by it.
 *
 * - `weave` (RGBA float): R,G = octahedral yarn tangent, B = across-yarn h mapped to 0..1,
 *   A = along-yarn z as a fraction of the repeat.
 * - `relief` (RGBA8): R = height, G = ambient occlusion, B = gap mask (255 = no yarn),
 *   A = yarn id * 2 + (1 if weft), so the shader can recover both. Knits store course * 2.
 */
export interface WeaveMaps {
  size: number;
  /** Physical width / height of the repeat. */
  aspect: number;
  knitted: boolean;
  weave: Float32Array;
  relief: Uint8Array;
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
  aspect: number;
  knitted: boolean;
}

function bake(src: BakeSource, options: BakeOptions): WeaveMaps {
  const { size } = options;
  if (!Number.isInteger(size) || size < 8 || size > 4096) throw new RangeError(`Bake size must be an integer 8..4096, got ${size}`);

  const weave = new Float32Array(size * size * 4);
  const relief = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
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
      relief[i * 4 + 0] = Math.round(h01 * 255);
      relief[i * 4 + 2] = s.kind === YarnKind.None ? 255 : 0;
      relief[i * 4 + 3] = s.kind === YarnKind.None ? 0 : s.yarnId * 2 + (s.kind === YarnKind.Weft ? 1 : 0);
    }
  }

  // Cheap cavity occlusion: texels below their neighbourhood average are darkened.
  const radius = Math.max(1, Math.round(size / src.cells / 4));
  const blurred = boxBlur(height, size, radius);
  for (let i = 0; i < size * size; i++) {
    const cavity = Math.max(0, blurred[i]! - height[i]!) * 4;
    relief[i * 4 + 1] = Math.round(255 * Math.max(0, 1 - options.aoStrength * Math.min(1, cavity)));
  }

  return { size, aspect: src.aspect, knitted: src.knitted, weave, relief };
}

export function bakeWeaveMaps(pattern: WeavePattern, params: WeaveParams, options: BakeOptions = defaultBakeOptions): WeaveMaps {
  return bake(
    {
      sample: (u, v) => sampleWeave(pattern, params, u, v),
      maxHeight: maxWeaveHeight(params),
      cells: Math.max(pattern.rows, pattern.cols),
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
