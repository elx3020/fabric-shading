import type { FabricAsset, FabricShading } from './asset/fabricFile.ts';
import { bakeTwoLayerLut } from './lut/twoLayer.ts';
import { bakeWaveNoise, type WaveNoiseParams } from './noise/waveNoise.ts';
import { bakeKnitMaps, bakeWeaveMaps, type BakeOptions, defaultBakeOptions, type WeaveMaps } from './patterns/bake.ts';
import { defaultKnitParams, type KnitParams, type KnitPattern } from './patterns/knit.ts';
import { bakeMomentMips, bakeTwoLobeMips } from './patterns/moments.ts';
import { defaultWeaveParams, type WeaveParams, type WeavePattern } from './patterns/weave.ts';
import { knitPresets, wovenPresets, type YarnData } from './presets.ts';

export type FabricSpec = (
  | { kind: 'woven'; pattern: WeavePattern; params?: Partial<WeaveParams> }
  | { kind: 'knit'; pattern: KnitPattern; params?: Partial<KnitParams> }
) & {
  name?: string;
  /** sRGB base colour, 0..1. */
  color?: readonly [number, number, number];
  /** Measured or estimated yarn data; sets the physical thread spacing. */
  yarn?: YarnData;
  bake?: Partial<BakeOptions>;
  noise?: Partial<WaveNoiseParams>;
  /** Optical depth of one yarn layer (opacity). */
  yarnDensity?: number;
  /** Share of scattered light that leaves backward. */
  backFraction?: number;
  /** Editor or app state to keep with the asset. */
  settings?: Record<string, unknown>;
};

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Approximate yarn diameter from ply count and diameter (circle packing of the plies). */
export function yarnDiameterUm(yarn: YarnData): number {
  return yarn.plyDiameterUm * ([1, 2, 2.15, 2.41][yarn.plies - 1] ?? Math.sqrt(yarn.plies) * 1.25);
}

/** Open area fraction of baked maps (mean of the gap mask). */
export function gapFractionOf(maps: WeaveMaps): number {
  let gaps = 0;
  for (let i = 2; i < maps.relief.length; i += 4) gaps += maps.relief[i]!;
  return gaps / 255 / (maps.size * maps.size);
}

/**
 * Physical shading inputs derived from the pattern: thread spacing from the yarn diameter,
 * gap half-widths from the yarn widths, and the coherent beam ratio for diffraction.
 */
export function fabricShading(spec: FabricSpec, maps: WeaveMaps, threadSpacingUm?: number): FabricShading {
  const color = spec.color ?? [0.8, 0.8, 0.8];
  const knit = spec.kind === 'knit';
  const params = knit ? { ...defaultKnitParams, ...spec.params } : { ...defaultWeaveParams, ...spec.params };
  const diameter = spec.yarn ? yarnDiameterUm(spec.yarn) : 200;
  const spacing =
    threadSpacingUm ??
    (knit ? diameter / (2 * (params as KnitParams).yarnRadius) : diameter / Math.max((params as WeaveParams).warpWidth, 0.2));
  const ax = knit ? 0.2 * spacing : (Math.max(1 - (params as WeaveParams).warpWidth, 0.02) * spacing) / 2;
  const ay = knit ? 0.2 * spacing : (Math.max(1 - (params as WeaveParams).weftWidth, 0.02) * spacing) / 2;
  const cols = spec.pattern.cols;
  const rows = spec.pattern.rows;
  return {
    albedo: [srgbToLinear(color[0]), srgbToLinear(color[1]), srgbToLinear(color[2])],
    yarnsPerRepeat: cols,
    threadSpacingUm: spacing,
    gapHalfWidthUm: [ax, ay],
    beamRatio: [spacing / 2 / ax, spacing / 2 / ay],
    repeatSizeUm: [cols * spacing, (cols * spacing) / maps.aspect],
    gapFraction: gapFractionOf(maps),
    rows,
  };
}

/** Bakes everything a fabric material needs, in about 0.1 to 0.4 s on desktop. */
export function bakeFabric(spec: FabricSpec): FabricAsset {
  const bake = { ...defaultBakeOptions, ...spec.bake };
  const maps =
    spec.kind === 'knit'
      ? bakeKnitMaps(spec.pattern, { ...defaultKnitParams, ...spec.params }, bake)
      : bakeWeaveMaps(spec.pattern, { ...defaultWeaveParams, ...spec.params }, bake);
  const shading = fabricShading(spec, maps);
  const gapDepth = spec.kind === 'knit' ? { ...defaultKnitParams, ...spec.params }.yarnRadius * 2 : { ...defaultWeaveParams, ...spec.params }.flatness * 0.5;
  return {
    name: spec.name ?? spec.pattern.name,
    settings: spec.settings ?? {},
    maps,
    moments: bakeMomentMips(maps),
    twoLobes: bakeTwoLobeMips(maps),
    twoLayer: bakeTwoLayerLut({
      albedo: shading.albedo,
      tau: spec.yarnDensity ?? 1.5,
      backFraction: spec.backFraction ?? 0.35,
      gapFraction: shading.gapFraction,
      gapDepth,
    }),
    noise: bakeWaveNoise(spec.noise),
    shading,
    ...(spec.yarn ? { yarn: spec.yarn } : {}),
  };
}

export const fabricPresetIds: readonly string[] = [...wovenPresets, ...knitPresets].map((p) => p.id);

/** Bakes one of the built-in presets (see `wovenPresets` and `knitPresets`). */
export function fabricFromPreset(id: string, overrides: Partial<Pick<FabricSpec, 'bake' | 'noise' | 'color'>> = {}): FabricAsset {
  const woven = wovenPresets.find((p) => p.id === id);
  if (woven) {
    return bakeFabric({ kind: 'woven', pattern: woven.pattern(), params: woven.params, color: woven.color, yarn: woven.yarn, name: woven.label, settings: { preset: id }, ...overrides });
  }
  const knit = knitPresets.find((p) => p.id === id);
  if (knit) {
    return bakeFabric({ kind: 'knit', pattern: knit.pattern(), params: knit.params, color: knit.color, yarn: knit.yarn, name: knit.label, settings: { preset: id }, ...overrides });
  }
  throw new Error(`Unknown fabric preset "${id}"`);
}
