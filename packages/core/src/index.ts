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
export { bakeWeaveMaps, decodeYarnId, defaultBakeOptions, type BakeOptions, type WeaveMaps } from './patterns/bake.ts';
export { wovenPresets, type WovenPreset, type YarnData } from './presets.ts';
