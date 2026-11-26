import { describe, expect, it } from 'vitest';
import { bakeDiffractionLut, diffractionDensity, diffractionLutR, slitProfile } from './diffraction.ts';
import { bakeTwoLayerLut, gapAt, hemisphericalAlbedo, layerAlbedo, twoLayerAlbedo, type TwoLayerParams } from './twoLayer.ts';

const white: TwoLayerParams = { albedo: [1, 1, 1], tau: 1.5, backFraction: 0.35, gapFraction: 0, gapDepth: 0.5 };

function integrate(f: (x: number) => number, a: number, b: number, n = 4000): number {
  const h = (b - a) / n;
  let s = 0;
  for (let i = 0; i < n; i++) s += f(a + (i + 0.5) * h);
  return s * h;
}

describe('two-layer correction', () => {
  it('conserves energy for white yarn, in one layer and with all bounces', () => {
    for (const mu of [0.05, 0.3, 0.7, 1]) {
      const one = layerAlbedo(white, mu);
      expect(one.B[0] + one.F[0]).toBeCloseTo(1, 6);
      const two = twoLayerAlbedo(white, mu);
      expect(two.B[1] + two.F[1]).toBeCloseTo(1, 3);
    }
  });

  it('absorbs energy for coloured yarn and keeps channels independent', () => {
    const p: TwoLayerParams = { ...white, albedo: [0.9, 0.5, 0.1] };
    const two = twoLayerAlbedo(p, 0.8);
    for (let c = 0; c < 3; c++) expect(two.B[c]! + two.F[c]!).toBeLessThan(1);
    expect(two.B[0]).toBeGreaterThan(two.B[1]);
    expect(two.B[1]).toBeGreaterThan(two.B[2]);
  });

  it('brightens reflection and darkens transmission compared with one layer', () => {
    const one = layerAlbedo(white, 0.8);
    const two = twoLayerAlbedo(white, 0.8);
    expect(two.B[0]).toBeGreaterThan(one.B[0]);
    expect(two.F[0]).toBeLessThan(one.F[0]);
  });

  it('averages over the hemisphere with cosine weight', () => {
    const constant: TwoLayerParams = { ...white, tau: 0 };
    expect(hemisphericalAlbedo(constant).F[0]).toBeCloseTo(1, 4);
  });

  it('closes gaps at oblique angles', () => {
    const p = { ...white, gapFraction: 0.2, gapDepth: 0.5 };
    expect(gapAt(p, 1)).toBeCloseTo(0.2, 6);
    expect(gapAt(p, 0.7)).toBeLessThan(0.2);
    expect(gapAt(p, 0.3)).toBe(0);
  });

  it('bakes gain >= 1 and the forward albedo into two rows', () => {
    const lut = bakeTwoLayerLut({ albedo: [0.8, 0.4, 0.2], gapFraction: 0.1, gapDepth: 0.5 });
    expect(lut.data.length).toBe(32 * 2 * 4);
    for (let i = 0; i < 32; i++) {
      for (let c = 0; c < 3; c++) {
        expect(lut.data[i * 4 + c]).toBeGreaterThanOrEqual(1);
        expect(lut.data[(32 + i) * 4 + c]).toBeGreaterThan(0);
        expect(lut.data[(32 + i) * 4 + c]).toBeLessThan(1);
      }
    }
    expect(lut.data[31 * 4 + 3]).toBeCloseTo(gapAt({ ...white, gapFraction: 0.1 }, 31.5 / 32), 5);
  });
});

describe('weave-gap diffraction', () => {
  it('integrates to 1 over u (Parseval), up to the tail beyond the table', () => {
    for (const r of [0.25, 1, 4]) {
      const inside = 2 * integrate((u) => slitProfile(u, r, 256), 0, 48);
      expect(inside).toBeGreaterThan(0.985);
      expect(inside).toBeLessThan(1.001);
    }
  });

  it('approaches a uniform slit (sinc squared) for a wide beam', () => {
    // Uniform slit: |U|^2 = 4 sin^2(u) / u^2 over a norm of 4 pi.
    const r = 50;
    expect(slitProfile(0, r)).toBeCloseTo(1 / Math.PI, 3);
    expect(slitProfile(Math.PI, r)).toBeLessThan(1e-3);
    expect(slitProfile(4.4934, r)).toBeCloseTo((4 * Math.sin(4.4934) ** 2) / 4.4934 ** 2 / (4 * Math.PI), 3);
  });

  it('approaches a Gaussian for a narrow beam', () => {
    const r = 0.15;
    for (const u of [0, 3, 6]) expect(slitProfile(u, r)).toBeCloseTo((r * Math.exp(-u * u * r * r)) / Math.sqrt(Math.PI), 3);
  });

  it('spreads wider for smaller gaps and longer wavelengths (inside the main lobe)', () => {
    const at = (a: number, lambda: number) => diffractionDensity(0.002, a, lambda, 2) / diffractionDensity(0, a, lambda, 2);
    expect(at(20, 0.45)).toBeGreaterThan(at(60, 0.45));
    expect(at(30, 0.65)).toBeGreaterThan(at(30, 0.45));
    expect(integrate((s) => diffractionDensity(s, 30, 0.55, 2), -0.5, 0.5)).toBeCloseTo(1, 2);
  });

  it('bakes the table row by row with log-spaced r', () => {
    const lut = bakeDiffractionLut();
    expect(lut.data.length).toBe(512 * 16);
    expect(diffractionLutR(lut, 0)).toBeCloseTo(0.25, 6);
    expect(diffractionLutR(lut, 15)).toBeCloseTo(4, 6);
    expect(lut.data[15 * 512]).toBeCloseTo(slitProfile(0, 4), 6);
    for (const v of lut.data) expect(v).toBeGreaterThanOrEqual(0);
  });
});
