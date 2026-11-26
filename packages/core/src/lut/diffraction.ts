/**
 * Weave-gap diffraction (Yu et al. 2025, section 5.4).
 *
 * Light behind sheer cloth passes the rectangular gaps between yarns and diffracts. For a
 * Gaussian beam over a rectangular aperture the far field separates into a product of two
 * 1D profiles, one per gap axis, which is what gives back-lit organza its cross-shaped glow.
 *
 * One 1D profile, in units of the gap half-width a and with t = x / a:
 *
 *   U(u) = integral over [-1, 1] of exp(-t^2 / (2 r^2)) exp(-i u t) dt,   u = 2 pi a sin(theta) / lambda
 *
 * r is the beam width over the gap half-width: large r is a uniformly lit slit (a sinc^2
 * pattern with side lobes), small r a beam narrower than the gap (a plain Gaussian). The table
 * stores I(u, r) = |U|^2 / (2 pi * integral of exp(-t^2 / r^2)), which by Parseval integrates
 * to 1 over u. The shader turns it into a density over sin(theta) by multiplying with
 * 2 pi a / lambda, per wavelength, so one table serves every gap size and colour.
 */
export interface DiffractionLutParams {
  /** Samples along u over [0, uMax]; the profile is even in u. */
  uSamples: number;
  uMax: number;
  /** Samples along r, log-spaced over [rMin, rMax]. */
  rSamples: number;
  rMin: number;
  rMax: number;
}

export const defaultDiffractionLutParams: DiffractionLutParams = {
  uSamples: 512,
  uMax: 128,
  rSamples: 16,
  rMin: 0.25,
  rMax: 4,
};

/** Normalized 1D diffraction profile I(u, r); integrates to 1 over u in (-inf, inf). */
export function slitProfile(u: number, r: number, steps = 1024): number {
  // The aperture function is even, so U is real: U = 2 * integral over [0, 1] of g(t) cos(u t).
  const h = 1 / steps;
  let amplitude = 0;
  let power = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i * h;
    const weight = i === 0 || i === steps ? 1 : i % 2 === 1 ? 4 : 2;
    const g = Math.exp((-t * t) / (2 * r * r));
    amplitude += weight * g * Math.cos(u * t);
    power += weight * g * g;
  }
  amplitude *= (2 * h) / 3;
  power *= (2 * h) / 3;
  return (amplitude * amplitude) / (2 * Math.PI * power);
}

/** r for row j of the table. */
export function diffractionLutR(p: DiffractionLutParams, j: number): number {
  return p.rMin * Math.pow(p.rMax / p.rMin, j / (p.rSamples - 1));
}

export interface DiffractionLut extends DiffractionLutParams {
  /** One float per texel, row-major: rSamples rows of uSamples; texel i at u = i / (uSamples - 1) * uMax. */
  data: Float32Array;
}

export function bakeDiffractionLut(params: Partial<DiffractionLutParams> = {}): DiffractionLut {
  const p = { ...defaultDiffractionLutParams, ...params };
  const data = new Float32Array(p.uSamples * p.rSamples);
  for (let j = 0; j < p.rSamples; j++) {
    const r = diffractionLutR(p, j);
    for (let i = 0; i < p.uSamples; i++) data[j * p.uSamples + i] = slitProfile((i / (p.uSamples - 1)) * p.uMax, r);
  }
  return { ...p, data };
}

/**
 * Reference density of the transmitted direction over sin(theta) along one gap axis,
 * for a gap half-width and wavelength in the same units. Integrates to 1.
 */
export function diffractionDensity(sinTheta: number, halfWidth: number, wavelength: number, r: number): number {
  const scale = (2 * Math.PI * halfWidth) / wavelength;
  return slitProfile(scale * sinTheta, r) * scale;
}
