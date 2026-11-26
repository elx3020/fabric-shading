import {
  DataArrayTexture,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  NearestFilter,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
  type Texture,
} from 'three/webgpu';
import { packHalf } from '../asset/half.ts';
import type { FabricAsset } from '../asset/fabricFile.ts';
import { bakeDiffractionLut, type DiffractionLut } from '../lut/diffraction.ts';

/** GPU textures for one fabric. Create with {@link createFabricTextures}, free with {@link disposeFabricTextures}. */
export interface FabricTextures {
  /** Octahedral tangent, across h, along z; nearest (tangents must not blend across yarns). */
  weave: DataTexture;
  /** Height, occlusion, gap, yarn id; nearest, for the yarn id. */
  relief: DataTexture;
  /** Height, occlusion, gap with a mip chain, for shading that must not alias. */
  shade: DataTexture;
  momentA: DataTexture;
  momentB: DataTexture;
  /** Quality tier; absent when the asset has no two-lobe mips. */
  lobes?: { a: DataTexture; b: DataTexture; c: DataTexture };
  twoLayer: DataTexture;
  noise: DataArrayTexture;
  noiseInstances: number;
  diffraction: DataTexture;
  diffractionLut: Pick<DiffractionLut, 'uMax' | 'rMin' | 'rMax'>;
}

function repeat<T extends Texture>(t: T): T {
  t.wrapS = t.wrapT = RepeatWrapping;
  return t;
}

function halfTexture(data: Float32Array, width: number, height: number): DataTexture {
  const t = new DataTexture(packHalf(data), width, height, RGBAFormat, HalfFloatType);
  t.magFilter = t.minFilter = LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

function mipChain(levels: { size: number; data: Float32Array }[]): DataTexture {
  const base = levels[0]!;
  const t = repeat(new DataTexture(packHalf(base.data), base.size, base.size, RGBAFormat, HalfFloatType));
  t.mipmaps = levels.map((l) => ({ data: packHalf(l.data), width: l.size, height: l.size }));
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** Box-filtered mips of the relief's height, occlusion and gap channels (yarn ids don't filter). */
function shadeTexture(relief: Uint8Array, size: number): DataTexture {
  const levels: { data: Uint8Array; width: number; height: number }[] = [];
  let n = size;
  let level = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    level[i * 4] = relief[i * 4]!;
    level[i * 4 + 1] = relief[i * 4 + 1]!;
    level[i * 4 + 2] = relief[i * 4 + 2]!;
    level[i * 4 + 3] = 255;
  }
  levels.push({ data: level, width: n, height: n });
  while (n > 1) {
    const m = n >> 1;
    const next = new Uint8Array(m * m * 4);
    for (let y = 0; y < m; y++) {
      for (let x = 0; x < m; x++) {
        for (let c = 0; c < 4; c++) {
          const s = (yy: number, xx: number) => level[((y * 2 + yy) * n + (x * 2 + xx)) * 4 + c]!;
          next[(y * m + x) * 4 + c] = (s(0, 0) + s(0, 1) + s(1, 0) + s(1, 1) + 2) >> 2;
        }
      }
    }
    level = next;
    n = m;
    levels.push({ data: level, width: n, height: n });
  }
  const t = repeat(new DataTexture(levels[0]!.data, size, size, RGBAFormat, UnsignedByteType));
  t.mipmaps = levels;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

let sharedDiffraction: { texture: DataTexture; lut: DiffractionLut } | undefined;

/** The diffraction table is the same for every fabric; baked once (about 0.15 s) and shared. */
export function diffractionTexture(): { texture: DataTexture; lut: DiffractionLut } {
  if (!sharedDiffraction) {
    const lut = bakeDiffractionLut();
    const rgba = new Float32Array(lut.data.length * 4);
    for (let i = 0; i < lut.data.length; i++) rgba[i * 4] = lut.data[i]!;
    sharedDiffraction = { texture: halfTexture(rgba, lut.uSamples, lut.rSamples), lut };
  }
  return sharedDiffraction;
}

export function createFabricTextures(asset: FabricAsset): FabricTextures {
  const { maps } = asset;
  const weave = repeat(new DataTexture(packHalf(maps.weave), maps.size, maps.size, RGBAFormat, HalfFloatType));
  const relief = repeat(new DataTexture(maps.relief, maps.size, maps.size, RGBAFormat, UnsignedByteType));
  for (const t of [weave, relief]) {
    t.magFilter = t.minFilter = NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
  }
  const noise = repeat(new DataArrayTexture(asset.noise.data, asset.noise.size, asset.noise.size, asset.noise.layers));
  noise.format = RGBAFormat;
  noise.type = UnsignedByteType;
  noise.magFilter = noise.minFilter = LinearFilter;
  noise.generateMipmaps = false;
  noise.needsUpdate = true;
  const diffraction = diffractionTexture();
  return {
    weave,
    relief,
    shade: shadeTexture(maps.relief, maps.size),
    momentA: mipChain(asset.moments.map((l) => ({ size: l.size, data: l.a }))),
    momentB: mipChain(asset.moments.map((l) => ({ size: l.size, data: l.b }))),
    ...(asset.twoLobes
      ? {
          lobes: {
            a: mipChain(asset.twoLobes.map((l) => ({ size: l.size, data: l.a }))),
            b: mipChain(asset.twoLobes.map((l) => ({ size: l.size, data: l.b }))),
            c: mipChain(asset.twoLobes.map((l) => ({ size: l.size, data: l.c }))),
          },
        }
      : {}),
    twoLayer: halfTexture(asset.twoLayer.data, asset.twoLayer.samples, 2),
    noise,
    noiseInstances: asset.noise.instances,
    diffraction: diffraction.texture,
    diffractionLut: diffraction.lut,
  };
}

/** Frees one fabric's textures; the shared diffraction table stays. */
export function disposeFabricTextures(t: FabricTextures): void {
  for (const tex of [t.weave, t.relief, t.shade, t.momentA, t.momentB, t.twoLayer, t.noise]) tex.dispose();
  if (t.lobes) for (const tex of [t.lobes.a, t.lobes.b, t.lobes.c]) tex.dispose();
}
