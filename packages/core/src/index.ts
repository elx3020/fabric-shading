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
  yarnNormal,
  type WeaveParams,
  type WeavePattern,
  type WeaveSample,
} from './patterns/weave.ts';
export { bakeKnitMaps, bakeWeaveMaps, decodeYarnId, defaultBakeOptions, deriveYarnNormals, horizonMap, type BakeOptions, type WeaveMaps } from './patterns/bake.ts';
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
export { knitPresets, type KnitPreset, type SheenParams } from './presets.ts';
export { sheenAlbedo, sheenLobe, sheenLtcAInv, sheenLtcBInv } from './lut/sheen.ts';
export { wovenPresets, type WovenPreset, type YarnData } from './presets.ts';
export { bakeMomentMips, bakeTwoLobeMips, type MomentLevel, type TwoLobeLevel } from './patterns/moments.ts';
export { bakeWaveNoise, decodeWaveNoise, defaultWaveNoiseParams, encodeWaveNoise, WAVE_NOISE_MAX, type WaveNoiseParams, type WaveNoiseTiles } from './noise/waveNoise.ts';
export { fiberSggx, sggxD, sggxSigma, sggxSpecular, tangentMoment, type Sym3 } from './shading/sggx.ts';
export {
  bakeTwoLayerLut,
  defaultTwoLayerParams,
  gapAt,
  hemisphericalAlbedo,
  layerAlbedo,
  twoLayerAlbedo,
  type TwoLayerLut,
  type TwoLayerParams,
} from './lut/twoLayer.ts';
export {
  bakeDiffractionLut,
  defaultDiffractionLutParams,
  diffractionDensity,
  diffractionLutR,
  slitProfile,
  type DiffractionLut,
  type DiffractionLutParams,
} from './lut/diffraction.ts';
export { decodeFabric, encodeFabric, FABRIC_FILE_VERSION, readFabric, writeFabric, type FabricAsset } from './asset/fabricFile.ts';
export { fromHalf, packHalf, toHalf, unpackHalf } from './asset/half.ts';
export {
  bakeFabric,
  fabricFromPreset,
  fabricPresetIds,
  defaultSheen,
  fabricShading,
  fiberParams,
  gapFractionOf,
  srgbToLinear,
  yarnDiameterUm,
  type FabricSpec,
} from './fabric.ts';
export type { FabricShading } from './asset/fabricFile.ts';
