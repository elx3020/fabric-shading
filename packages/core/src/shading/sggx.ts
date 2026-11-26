import type { Vec3 } from '../patterns/octahedral.ts';

/** Symmetric 3x3 matrix stored as [xx, yy, zz, xy, xz, yz]. */
export type Sym3 = [number, number, number, number, number, number];

/**
 * SGGX matrix of a fiber-like microflake distribution (Heitz et al. 2015):
 * flakes are normal to the fiber, so S = alpha^2 t t^T + (I - t t^T).
 * Written through the tangent second moment M = E[t t^T] it stays linear,
 * which is what lets M be mipmapped and alpha change at runtime.
 */
export function fiberSggx(moment: Sym3, alpha: number): Sym3 {
  const k = 1 - alpha * alpha;
  const [xx, yy, zz, xy, xz, yz] = moment;
  return [1 - k * xx, 1 - k * yy, 1 - k * zz, -k * xy, -k * xz, -k * yz];
}

export function tangentMoment(t: Vec3): Sym3 {
  return [t[0] * t[0], t[1] * t[1], t[2] * t[2], t[0] * t[1], t[0] * t[2], t[1] * t[2]];
}

function quad(s: Sym3, w: Vec3): number {
  const [xx, yy, zz, xy, xz, yz] = s;
  const [x, y, z] = w;
  return xx * x * x + yy * y * y + zz * z * z + 2 * (xy * x * y + xz * x * z + yz * y * z);
}

function det(s: Sym3): number {
  const [xx, yy, zz, xy, xz, yz] = s;
  return xx * (yy * zz - yz * yz) - xy * (xy * zz - yz * xz) + xz * (xy * yz - yy * xz);
}

function inverse(s: Sym3): Sym3 {
  const [xx, yy, zz, xy, xz, yz] = s;
  const d = det(s);
  return [
    (yy * zz - yz * yz) / d,
    (xx * zz - xz * xz) / d,
    (xx * yy - xy * xy) / d,
    (xz * yz - xy * zz) / d,
    (xy * yz - xz * yy) / d,
    (xy * xz - xx * yz) / d,
  ];
}

/** Projected area of the flakes seen from direction w. */
export function sggxSigma(s: Sym3, w: Vec3): number {
  return Math.sqrt(Math.max(0, quad(s, w)));
}

/**
 * Distribution of flake normals. Normalised so that the clamped-cosine integral equals the
 * projected area: integral of max(0, w.m) D(m) dm = sigma(w); for S = I it is 1/pi.
 */
export function sggxD(s: Sym3, m: Vec3): number {
  const q = quad(inverse(s), m);
  return 1 / (Math.PI * Math.sqrt(Math.max(det(s), 1e-30)) * q * q);
}

/**
 * Jin et al. 2022 specular term (as used by Yang et al. 2026): microflake slab of optical
 * thickness `tau` (= T rho) seen from a surface with normal +z.
 */
export function sggxSpecular(s: Sym3, wi: Vec3, wo: Vec3, tau: number): number {
  const ci = wi[2];
  const co = wo[2];
  if (ci <= 0 || co <= 0) return 0;
  const h: Vec3 = [wi[0] + wo[0], wi[1] + wo[1], wi[2] + wo[2]];
  const hl = Math.hypot(...h);
  const hn: Vec3 = [h[0] / hl, h[1] / hl, h[2] / hl];
  const li = sggxSigma(s, wi) / ci;
  const lo = sggxSigma(s, wo) / co;
  const g = (1 - Math.exp(-tau * (li + lo))) / (li + lo);
  return (sggxD(s, hn) * g) / (4 * ci * co);
}
