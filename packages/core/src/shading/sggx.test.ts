import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../patterns/octahedral.ts';
import { fiberSggx, sggxD, sggxSigma, sggxSpecular, tangentMoment, type Sym3 } from './sggx.ts';

/** Fibonacci sphere quadrature. */
function integrate(f: (w: Vec3) => number, n = 200_000): number {
  let sum = 0;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const z = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - z * z);
    const phi = golden * i;
    sum += f([r * Math.cos(phi), r * Math.sin(phi), z]);
  }
  return (sum * 4 * Math.PI) / n;
}

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};

describe('SGGX', () => {
  const t = norm([0.6, 0.7, 0.2]);
  const s = fiberSggx(tangentMoment(t), 0.5);

  it('is 1/pi everywhere for the isotropic S = I', () => {
    expect(sggxD([1, 1, 1, 0, 0, 0], norm([0.3, -0.2, 0.9]))).toBeCloseTo(1 / Math.PI, 12);
  });

  it('projected area equals the integral of the clamped <w, m> D (Heitz 2015 normalisation)', () => {
    const w = norm([0.2, -0.3, 0.9]);
    const projected = integrate((m) => Math.max(0, w[0] * m[0] + w[1] * m[1] + w[2] * m[2]) * sggxD(s, m));
    expect(projected).toBeCloseTo(sggxSigma(s, w), 2);
  });

  it('puts fiber flake normals perpendicular to the tangent', () => {
    const sharp = fiberSggx(tangentMoment([1, 0, 0]), 0.1);
    expect(sggxD(sharp, [0, 0, 1])).toBeGreaterThan(100 * sggxD(sharp, [1, 0, 0]));
    // Seen along the fiber, flakes present almost no area.
    expect(sggxSigma(sharp, [1, 0, 0])).toBeLessThan(0.2);
  });

  it('averaging moments matches averaging the distributions for alpha = 1 reference', () => {
    // alpha = 1 gives an isotropic distribution whatever the tangent.
    const iso = fiberSggx(tangentMoment(t), 1);
    const expected: Sym3 = [1, 1, 1, 0, 0, 0];
    iso.forEach((v, k) => expect(v).toBeCloseTo(expected[k]!, 12));
  });

  it('specular is reciprocal and zero below the horizon', () => {
    const wi = norm([0.3, 0.1, 0.8]);
    const wo = norm([-0.4, 0.2, 0.7]);
    expect(sggxSpecular(s, wi, wo, 2)).toBeCloseTo(sggxSpecular(s, wo, wi, 2), 10);
    expect(sggxSpecular(s, wi, [0, 0.5, -0.8], 2)).toBe(0);
  });
});
