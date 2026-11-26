export { hash01 } from './patterns/hash.ts';
export { octDecode, octEncode, type Vec3 } from './patterns/octahedral.ts';
export {
  defaultWeaveParams,
  maxWeaveHeight,
  MAX_REPEAT,
  plainWeave,
  sampleWeave,
  satinWeave,
  twillWeave,
  YarnKind,
  type WeaveParams,
  type WeavePattern,
  type WeaveSample,
} from './patterns/weave.ts';
export { bakeKnitMaps, bakeWeaveMaps, decodeYarnId, defaultBakeOptions, type BakeOptions, type WeaveMaps } from './patterns/bake.ts';
export {
  defaultKnitParams,
  garterKnit,
  jerseyKnit,
  knitAspect,
  knitSampler,
  maxKnitHeight,
  ribKnit,
  seedKnit,
  type KnitParams,
  type KnitPattern,
  type Stitch,
} from './patterns/knit.ts';
export { knitPresets, type KnitPreset } from './presets.ts';
export { wovenPresets, type WovenPreset, type YarnData } from './presets.ts';
export { bakeMomentMips, type MomentLevel } from './patterns/moments.ts';
export { fiberSggx, sggxD, sggxSigma, sggxSpecular, tangentMoment, type Sym3 } from './shading/sggx.ts';
