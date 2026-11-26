import { describe, expect, it } from 'vitest';
import { wovenPresets } from '../presets.ts';
import { bakeTwoLayerLut } from './twoLayer.ts';
import {
  defaultFiberParams,
  fiberAttenuation,
  fibersCrossed,
  fitFiberAlbedo,
  plyAttenuation,
  yarnScattering,
} from './yarnScattering.ts';

const organza = wovenPresets.find((p) => p.id === 'silk-organza')!.yarn;

describe('yarn scattering', () => {
  it('reduces to the paper’s a_F^n without backscatter', () => {
    expect(plyAttenuation(0.9, 0, 7).F).toBeCloseTo(0.9 ** 7, 10);
    expect(plyAttenuation(0.9, 0, 7).B).toBe(0);
  });

  it('conserves energy for white fibers and loses it for coloured ones', () => {
    const white = { ...defaultFiberParams, albedo: [1, 1, 1] as const };
    for (const mu of [0.1, 0.5, 1]) {
      const f = fiberAttenuation(white, mu);
      expect(f.F[0] + f.B[0]).toBeCloseTo(1, 10);
      const y = yarnScattering(organza, white, mu);
      expect(y.F[0] + y.B[0]).toBeCloseTo(1, 6);
      const red = yarnScattering(organza, { ...white, albedo: [0.9, 0.5, 0.1] }, mu);
      expect(red.F[1] + red.B[1]).toBeLessThan(1);
      expect(red.F[2]).toBeLessThan(red.F[0]);
    }
  });

  it('crosses more fibers in denser plies', () => {
    expect(fibersCrossed({ ...organza, fibersPerPly: [80, 80] })).toBeGreaterThan(fibersCrossed(organza));
  });

  it('fits fiber colour so a deep stack reflects the cloth colour', () => {
    const target = [0.6, 0.2, 0.05] as const;
    const fiber = fitFiberAlbedo(target, defaultFiberParams);
    for (let c = 0; c < 3; c++) {
      const f = fiberAttenuation({ ...defaultFiberParams, albedo: fiber }, 2 / 3);
      expect(plyAttenuation(f.F[c]!, f.B[c]!, 32).B).toBeCloseTo(target[c]!, 3);
      expect(fiber[c]!).toBeGreaterThan(target[c]!);
    }
  });

  it('feeds the two-layer table with a straight-through share in [0, 1]', () => {
    const fiber = { ...defaultFiberParams, albedo: fitFiberAlbedo([0.8, 0.8, 0.8], defaultFiberParams) };
    const lut = bakeTwoLayerLut({ yarn: { data: organza, fiber } });
    for (let i = 0; i < lut.samples; i++) {
      const straight = lut.data[(lut.samples + i) * 4 + 3]!;
      expect(straight).toBeGreaterThanOrEqual(0);
      expect(straight).toBeLessThanOrEqual(1);
      expect(lut.data[(lut.samples + i) * 4]!).toBeGreaterThan(0);
    }
  });
});
