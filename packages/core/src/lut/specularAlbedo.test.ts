import { describe, expect, it } from 'vitest';
import { bakeSpecularAlbedo } from './specularAlbedo.ts';
import { fresnel } from './yarnScattering.ts';

const satin = [0.17, 0.79, 0.04, 0, 0, 0] as [number, number, number, number, number, number];

describe('specular albedo for environment light', () => {
  const lut = bakeSpecularAlbedo(satin, { steps: 12 });
  const at = (i: number, j: number) => lut.data[j * lut.muSamples + i]!;

  it('stays a few percent, far below macro-normal Fresnel at grazing', () => {
    for (let j = 0; j < lut.alphaSamples; j++) {
      for (let i = 0; i < lut.muSamples; i++) {
        expect(at(i, j)).toBeGreaterThan(0);
        expect(at(i, j)).toBeLessThan(0.1);
      }
      // The old environment term used Fresnel on the macro normal: ~0.6 at mu = 0.03.
      expect(at(0, j)).toBeLessThan(fresnel(1.55, 0.5 / lut.muSamples) / 8);
    }
  });

  it('grows gently toward grazing', () => {
    expect(at(0, 2)).toBeGreaterThan(at(lut.muSamples - 1, 2));
    expect(at(0, 2) / at(lut.muSamples - 1, 2)).toBeLessThan(6);
  });

  it('keeps a Fresnel-free channel for tinted fiber transmission', () => {
    for (let k = 0; k < lut.data.length; k++) expect(lut.bare[k]!).toBeGreaterThan(lut.data[k]!);
  });
});
