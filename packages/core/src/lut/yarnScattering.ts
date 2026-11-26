/**
 * Yarn-level multiple scattering (Zhu, Montazeri, Aubry, Yan, Weidlich, EGSR 2023).
 *
 * The paper aggregates fiber scattering into ply lobes, and ply lobes into yarn lobes, with
 * dual scattering: light crossing a ply meets n_I fibers, and each fiber sends a share a_F of
 * what reaches it forward and a share a_B backward.
 *
 *   ply:   a_F^ply = a_F^nI, a_B^ply = one and three back bounces (we add all orders, see plyAttenuation)
 *   yarn:  a_F^yarn = prod over crossed plies of a_F^ply
 *          a_B^yarn = sum over crossed plies of a_B^ply (1 + a_F^ply^2)   (paths B and FBF; we add all orders)
 *
 * The fiber's own lobes are R (Fresnel reflection), TT (light that passes through the fiber,
 * tinted by its colour) and D (light scattered inside a dyed or delustered fiber). Their
 * forward and backward shares come from the azimuthal distributions: R and D are uniform
 * over the circle, so half goes each way; TT is a narrow Gaussian around straight through.
 *
 * We keep the paper's attenuations and leave out its lobe shapes except for the forward
 * width, because on a phone the yarn lobes only feed the two-layer table: they give backward
 * and forward albedos per incident angle, and how much of the forward light still travels
 * close to straight through (the glow around a light seen through cloth).
 */
import type { YarnData } from '../presets.ts';

export type Rgb = [number, number, number];

export interface FiberParams {
  /** Linear RGB colour of the fiber material (absorption of light that enters it). */
  albedo: readonly [number, number, number];
  ior: number;
  /** Share of light entering a fiber that leaves it unscattered (TT) rather than diffusely (D). */
  clarity: number;
  /** Share of TT that heads forward (the azimuthal Gaussian's mass within the front half). */
  ttForward: number;
  /** Longitudinal roughness of TT, radians. */
  ttRoughness: number;
}

export const defaultFiberParams: FiberParams = {
  albedo: [0.8, 0.8, 0.8],
  ior: 1.55,
  clarity: 0.85,
  ttForward: 0.9,
  ttRoughness: 0.15,
};

/** Schlick Fresnel reflectance of a dielectric. */
export function fresnel(ior: number, cosTheta: number): number {
  const f0 = ((ior - 1) / (ior + 1)) ** 2;
  return f0 + (1 - f0) * (1 - Math.min(Math.max(cosTheta, 0), 1)) ** 5;
}

/** Forward and backward attenuation of one fiber, and the share of forward light that is TT. */
export function fiberAttenuation(p: FiberParams, mu: number): { F: Rgb; B: Rgb; narrow: Rgb } {
  const r = fresnel(p.ior, mu);
  const F: Rgb = [0, 0, 0];
  const B: Rgb = [0, 0, 0];
  const narrow: Rgb = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = p.albedo[c]!;
    const tt = (1 - r) * p.clarity * a;
    const d = (1 - r) * (1 - p.clarity) * a;
    const forward = r / 2 + tt * p.ttForward + d / 2;
    F[c] = forward;
    B[c] = r / 2 + tt * (1 - p.ttForward) + d / 2;
    narrow[c] = forward > 0 ? (tt * p.ttForward) / forward : 0;
  }
  return { F, B, narrow };
}

/**
 * Mean number of fibers a ray crosses in one ply: n_I = d l n / pi with the fiber density
 * d = c n (r_f / r_p)^2 / cos(theta_twist) and the mean chord l = pi / 2 of a unit circle.
 */
export function fibersCrossed(yarn: YarnData, packing = 1): number {
  const n = (yarn.fibersPerPly[0] + yarn.fibersPerPly[1]) / 2;
  const twist = Math.atan((Math.PI * yarn.plyDiameterUm) / Math.max(yarn.twistPitchUm, 1));
  const density = Math.min((packing * n * (yarn.fiberDiameterUm / yarn.plyDiameterUm) ** 2) / Math.cos(twist), 0.9);
  return Math.max(1, Math.round((density * n) / 2));
}

/**
 * Ply attenuation from per-fiber attenuation. Zhu et al. (equations 8 to 10) keep paths with
 * one or three backward bounces, which loses most forward light once fibers scatter strongly
 * (white or delustered yarn). We instead add the n_I fiber layers exactly in a two-stream
 * model, which sums every bounce order and costs O(n_I):
 *
 *   T_(a+b) = T_a T_b / (1 - R_a R_b)      R_(a+b) = R_a + T_a^2 R_b / (1 - R_a R_b)
 *
 * With no backscatter (a_B = 0) both reduce to the paper's a_F^nI.
 */
export function plyAttenuation(aF: number, aB: number, nI: number): { F: number; B: number } {
  let F = aF;
  let B = aB;
  for (let i = 1; i < nI; i++) {
    const series = 1 / (1 - B * aB);
    B = B + F * F * aB * series;
    F = F * aF * series;
  }
  return { F, B };
}

export interface YarnScattering {
  /** Backward albedo of one yarn layer. */
  B: Rgb;
  /** Forward albedo of one yarn layer. */
  F: Rgb;
  /** Share of F that stayed on fully forward TT paths, so it still travels near straight through. */
  narrow: Rgb;
}

/** Plies a ray crosses: one for a single-ply yarn, otherwise about two (Zhu et al., section 4.4). */
export function pliesCrossed(yarn: YarnData): number {
  return Math.min(yarn.plies, 2);
}

export function yarnScattering(yarn: YarnData, fiber: FiberParams, mu: number): YarnScattering {
  const nI = fibersCrossed(yarn);
  const q = pliesCrossed(yarn);
  const fib = fiberAttenuation(fiber, mu);
  const B: Rgb = [0, 0, 0];
  const F: Rgb = [0, 0, 0];
  const narrow: Rgb = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const ply = plyAttenuation(fib.F[c]!, fib.B[c]!, nI);
    // The paper keeps paths B and FBF between plies; adding the plies keeps every bounce.
    let f = ply.F;
    let b = ply.B;
    for (let k = 1; k < q; k++) {
      const series = 1 / (1 - b * ply.B);
      b = b + f * f * ply.B * series;
      f = f * ply.F * series;
    }
    F[c] = f;
    B[c] = b;
    narrow[c] = fib.narrow[c]! ** (nI * q);
  }
  return { B, F, narrow };
}

/**
 * Longitudinal variance of the forward yarn lobe: the TT variances of every crossed fiber add
 * up (Zhu et al., equations 11 and 17). Returned in radians squared.
 */
export function forwardVariance(yarn: YarnData, fiber: FiberParams): number {
  return fibersCrossed(yarn) * pliesCrossed(yarn) * fiber.ttRoughness ** 2;
}

/**
 * Fiber colour that makes a deep stack of fibers reflect `target` (linear RGB, at the
 * cosine-weighted mean angle). Fabric colours are measured on the cloth, not on one fiber:
 * a fiber that passes most light on is far paler than the cloth it builds.
 */
export function fitFiberAlbedo(target: readonly [number, number, number], fiber: Omit<FiberParams, 'albedo'>, deep = 32): Rgb {
  const out: Rgb = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const reflect = (a: number) => {
      const f = fiberAttenuation({ ...fiber, albedo: [a, a, a] }, 2 / 3);
      return plyAttenuation(f.F[0], f.B[0], deep).B;
    };
    const goal = Math.min(Math.max(target[c]!, 0), reflect(1));
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (reflect(mid) < goal) lo = mid;
      else hi = mid;
    }
    out[c] = (lo + hi) / 2;
  }
  return out;
}
