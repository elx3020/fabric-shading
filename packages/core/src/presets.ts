import { plainWeave, satinWeave, twillWeave, type WeaveParams, type WeavePattern } from './patterns/weave.ts';

/** Fiber and yarn data measured by Yu et al. 2025 (supplemental), used by the shading model later. */
export interface YarnData {
  plies: number;
  fibersPerPly: [number, number];
  plyDiameterUm: number;
  fiberDiameterUm: number;
  twistPitchUm: number;
  ior: number;
}

export interface WovenPreset {
  id: string;
  label: string;
  pattern: () => WeavePattern;
  params: Partial<WeaveParams>;
  yarn: YarnData;
  /** sRGB albedo the sample was photographed with. */
  color: [number, number, number];
}

/**
 * Pattern parameters (widths, crimp, flatness) are visual estimates from the photos;
 * yarn data is as measured in the supplemental.
 */
export const wovenPresets: readonly WovenPreset[] = [
  {
    id: 'polyester-satin',
    label: 'Orange polyester satin',
    pattern: () => satinWeave(5, 2, true),
    params: { warpWidth: 1, weftWidth: 0.95, crimp: 0.3, flatness: 0.35, irregularity: 0.15 },
    yarn: { plies: 1, fibersPerPly: [45, 50], plyDiameterUm: 220, fiberDiameterUm: 18, twistPitchUm: 10000, ior: 1.57 },
    color: [0.85, 0.32, 0.12],
  },
  {
    id: 'silk-satin',
    label: 'Beige silk satin',
    pattern: () => satinWeave(8, 3, true),
    params: { warpWidth: 1, weftWidth: 0.9, crimp: 0.3, flatness: 0.35, irregularity: 0.15 },
    yarn: { plies: 1, fibersPerPly: [35, 40], plyDiameterUm: 110, fiberDiameterUm: 12, twistPitchUm: 2500, ior: 1.54 },
    color: [0.82, 0.74, 0.6],
  },
  {
    id: 'cotton-satin',
    label: 'Blue cotton satin',
    pattern: () => satinWeave(5, 3, true),
    params: { warpWidth: 0.95, weftWidth: 0.9, crimp: 0.4, flatness: 0.5, irregularity: 0.3 },
    yarn: { plies: 3, fibersPerPly: [30, 35], plyDiameterUm: 80, fiberDiameterUm: 12, twistPitchUm: 2000, ior: 1.53 },
    color: [0.18, 0.28, 0.6],
  },
  {
    id: 'silk-organza',
    label: 'White silk organza',
    pattern: () => plainWeave(),
    params: { warpWidth: 0.45, weftWidth: 0.45, crimp: 0.6, flatness: 0.8, irregularity: 0.2 },
    yarn: { plies: 3, fibersPerPly: [20, 25], plyDiameterUm: 45, fiberDiameterUm: 10, twistPitchUm: 1000, ior: 1.54 },
    color: [0.92, 0.92, 0.9],
  },
  {
    id: 'polyester-plain',
    label: 'Black polyester plain weave',
    pattern: () => plainWeave(),
    params: { warpWidth: 0.92, weftWidth: 0.92, crimp: 0.6, flatness: 0.6, irregularity: 0.2 },
    yarn: { plies: 3, fibersPerPly: [25, 30], plyDiameterUm: 75, fiberDiameterUm: 12, twistPitchUm: 1200, ior: 1.57 },
    color: [0.03, 0.03, 0.035],
  },
  {
    id: 'cotton-twill',
    label: 'Cream cotton twill',
    pattern: () => twillWeave(2, 1),
    params: { warpWidth: 0.95, weftWidth: 0.9, crimp: 0.5, flatness: 0.6, irregularity: 0.35 },
    yarn: { plies: 3, fibersPerPly: [20, 25], plyDiameterUm: 55, fiberDiameterUm: 10, twistPitchUm: 1800, ior: 1.53 },
    color: [0.86, 0.82, 0.72],
  },
  {
    id: 'wool-twill',
    label: 'Gray wool twill',
    pattern: () => twillWeave(2, 2),
    params: { warpWidth: 1, weftWidth: 1, crimp: 0.5, flatness: 0.75, irregularity: 0.5 },
    yarn: { plies: 3, fibersPerPly: [38, 42], plyDiameterUm: 140, fiberDiameterUm: 15, twistPitchUm: 3000, ior: 1.55 },
    color: [0.42, 0.42, 0.42],
  },
];
