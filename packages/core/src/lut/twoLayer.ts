/**
 * Two-layer correction (Yu et al. 2025, section 5.3).
 *
 * Where warp and weft cross, light meets two yarn layers. Light that one layer transmits can
 * bounce between the layers any number of times, which a single-layer shading model misses:
 * cloth looks too dark in reflection and too bright in transmission. The paper folds the
 * bounces into a geometric series:
 *
 *   B_total = B_t + F_t B_b F_b / (1 - B_b^2)      F_total = F_t F_b / (1 - B_b^2)
 *
 * where B_t, F_t are the top layer's backward and forward albedo for the incident angle, and
 * B_b, F_b are the same quantities averaged over the hemisphere, because light between the
 * layers is already scattered.
 *
 * When the yarn's fiber data is known, a layer's albedos come from the yarn scattering model
 * of Zhu et al. (see yarnScattering.ts). Otherwise a layer is a slab of yarn with optical depth
 * tau and single-scattering albedo alpha: e^(-tau/mu) passes straight through, and the
 * scattered rest goes backward with probability beta. With alpha = 1 the slab conserves
 * energy, and so does the two-layer total.
 *
 * Open weave gaps are handled separately (they transmit light unscattered, and diffract it):
 * the gap fraction shrinks at oblique angles as the yarns' height closes the openings.
 */
import type { YarnData } from '../presets.ts';
import { yarnScattering, type FiberParams } from './yarnScattering.ts';

export interface TwoLayerParams {
  /** Per-channel single-scattering albedo of the yarn, linear RGB. */
  albedo: readonly [number, number, number];
  /** Optical depth of one yarn layer at normal incidence. */
  tau: number;
  /** Probability that scattered light leaves backward. */
  backFraction: number;
  /** Open area fraction at normal incidence (mean of the baked gap mask). */
  gapFraction: number;
  /** Yarn height over gap width; the gap closes when tan(theta) exceeds its inverse. */
  gapDepth: number;
  /** Fiber-level yarn model; replaces the slab (albedo, tau, backFraction) when present. */
  yarn?: { data: YarnData; fiber: FiberParams };
}

export const defaultTwoLayerParams: TwoLayerParams = {
  albedo: [0.8, 0.8, 0.8],
  tau: 1.5,
  backFraction: 0.35,
  gapFraction: 0,
  gapDepth: 0.5,
};

export type Rgb = [number, number, number];

/**
 * Backward and forward albedo of one yarn layer for light arriving at cos(theta) = mu, and the
 * share of the forward light that still travels near straight through.
 */
export function layerAlbedo(p: TwoLayerParams, mu: number): { B: Rgb; F: Rgb; narrow: Rgb } {
  if (p.yarn) return yarnScattering(p.yarn.data, p.yarn.fiber, mu);
  const direct = Math.exp(-p.tau / Math.max(mu, 1e-3));
  const scattered = 1 - direct;
  const B = p.albedo.map((a) => scattered * a * p.backFraction) as Rgb;
  const F = p.albedo.map((a) => direct + scattered * a * (1 - p.backFraction)) as Rgb;
  const narrow = F.map((f) => (f > 0 ? direct / f : 0)) as Rgb;
  return { B, F, narrow };
}

/** Cosine-weighted hemispherical average of a layer's albedo. */
export function hemisphericalAlbedo(p: TwoLayerParams, steps = 256): { B: Rgb; F: Rgb; straight: Rgb } {
  const B: Rgb = [0, 0, 0];
  const F: Rgb = [0, 0, 0];
  const straight: Rgb = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const mu = (i + 0.5) / steps;
    const l = layerAlbedo(p, mu);
    // Integral of X(mu) * 2 mu dmu over [0, 1].
    const w = (2 * mu) / steps;
    for (let c = 0; c < 3; c++) {
      B[c]! += l.B[c]! * w;
      F[c]! += l.F[c]! * w;
      straight[c]! += l.F[c]! * l.narrow[c]! * w;
    }
  }
  return { B, F, straight };
}

/** Yarn-covered region: albedos with all bounces between the two layers. */
export function twoLayerAlbedo(p: TwoLayerParams, mu: number, bottom = hemisphericalAlbedo(p)): { B: Rgb; F: Rgb } {
  const top = layerAlbedo(p, mu);
  const B: Rgb = [0, 0, 0];
  const F: Rgb = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const bb = bottom.B[c]!;
    const series = 1 / (1 - bb * bb);
    B[c] = top.B[c]! + top.F[c]! * bb * bottom.F[c]! * series;
    F[c] = top.F[c]! * bottom.F[c]! * series;
  }
  return { B, F };
}

/** Open area fraction at cos(theta) = mu. */
export function gapAt(p: TwoLayerParams, mu: number): number {
  const tan = Math.sqrt(Math.max(1 - mu * mu, 0)) / Math.max(mu, 1e-4);
  return p.gapFraction * Math.max(0, 1 - p.gapDepth * tan);
}

export interface TwoLayerLut {
  /** Samples over cos(theta) in (0, 1], sample i at mu = (i + 0.5) / samples. */
  samples: number;
  /**
   * RGBA float, two rows of `samples` texels.
   * Row 0: RGB = backward gain B_total / B_t (scales a single-layer reflection lobe), A = open gap fraction.
   * Row 1: RGB = forward albedo F_total of the yarn region, A = share of F_total that crossed both
   * layers without scattering away from straight through (luminance-weighted).
   */
  data: Float32Array;
}

export function bakeTwoLayerLut(params: Partial<TwoLayerParams> = {}, samples = 32): TwoLayerLut {
  const p = { ...defaultTwoLayerParams, ...params };
  const bottom = hemisphericalAlbedo(p);
  const data = new Float32Array(samples * 2 * 4);
  for (let i = 0; i < samples; i++) {
    const mu = (i + 0.5) / samples;
    const top = layerAlbedo(p, mu);
    const total = twoLayerAlbedo(p, mu, bottom);
    for (let c = 0; c < 3; c++) {
      data[i * 4 + c] = top.B[c]! > 1e-6 ? total.B[c]! / top.B[c]! : 1;
      data[(samples + i) * 4 + c] = total.F[c]!;
    }
    data[i * 4 + 3] = gapAt(p, mu);
    // Straight through both layers: the narrow parts multiply; back-bounced light is scattered.
    const w = [0.2126, 0.7152, 0.0722];
    let straight = 0;
    let all = 0;
    for (let c = 0; c < 3; c++) {
      straight += w[c]! * top.F[c]! * top.narrow[c]! * bottom.straight[c]!;
      all += w[c]! * total.F[c]!;
    }
    data[(samples + i) * 4 + 3] = all > 1e-6 ? Math.min(straight / all, 1) : 0;
  }
  return { samples, data };
}
