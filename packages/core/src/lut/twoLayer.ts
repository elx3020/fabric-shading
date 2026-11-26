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
 * Until the yarn lobes of step 3 exist, a layer is a slab of yarn with optical depth tau and
 * single-scattering albedo alpha: e^(-tau/mu) passes straight through, and the scattered rest
 * goes backward with probability beta. With alpha = 1 the slab conserves energy, and so does
 * the two-layer total. Step 3 replaces {@link layerAlbedo} with integrals of the real lobes;
 * the series and the table format stay.
 *
 * Open weave gaps are handled separately (they transmit light unscattered, and diffract it):
 * the gap fraction shrinks at oblique angles as the yarns' height closes the openings.
 */
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
}

export const defaultTwoLayerParams: TwoLayerParams = {
  albedo: [0.8, 0.8, 0.8],
  tau: 1.5,
  backFraction: 0.35,
  gapFraction: 0,
  gapDepth: 0.5,
};

export type Rgb = [number, number, number];

/** Backward and forward albedo of one yarn layer for light arriving at cos(theta) = mu. */
export function layerAlbedo(p: TwoLayerParams, mu: number): { B: Rgb; F: Rgb } {
  const direct = Math.exp(-p.tau / Math.max(mu, 1e-3));
  const scattered = 1 - direct;
  const B = p.albedo.map((a) => scattered * a * p.backFraction) as Rgb;
  const F = p.albedo.map((a) => direct + scattered * a * (1 - p.backFraction)) as Rgb;
  return { B, F };
}

/** Cosine-weighted hemispherical average of a layer's albedo. */
export function hemisphericalAlbedo(p: TwoLayerParams, steps = 256): { B: Rgb; F: Rgb } {
  const B: Rgb = [0, 0, 0];
  const F: Rgb = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const mu = (i + 0.5) / steps;
    const l = layerAlbedo(p, mu);
    // Integral of X(mu) * 2 mu dmu over [0, 1].
    const w = (2 * mu) / steps;
    for (let c = 0; c < 3; c++) {
      B[c]! += l.B[c]! * w;
      F[c]! += l.F[c]! * w;
    }
  }
  return { B, F };
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
   * Row 1: RGB = forward albedo F_total of the yarn region, A = luminance of B_total (for debugging).
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
    data[(samples + i) * 4 + 3] = 0.2126 * total.B[0] + 0.7152 * total.B[1] + 0.0722 * total.B[2];
  }
  return { samples, data };
}
