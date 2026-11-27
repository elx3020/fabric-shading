/**
 * Sheen from fly-away fibers: the multiple-scattering sheen of Zeltner, Burley and Chiang
 * ("Practical Multiple-Scattering Sheen Using Linearly Transformed Cosines", SIGGRAPH 2022 talk),
 * which Zhu et al. (SIGGRAPH 2024) put on top of their cloth model as a layer.
 *
 * The lobe is a clamped cosine stretched and skewed by a linear transform (an LTC) whose two
 * coefficients depend on the view angle and the sheen roughness. Those coefficients and the
 * lobe's directional albedo use the rational fits published with MaterialX's implementation,
 * so nothing has to be baked. The layer reflects `albedo` of the light toward the viewer and
 * passes on 1 - albedo to the cloth below.
 *
 * Coordinates: the macro normal is +z. `mu` is cos(theta_v), `r` the sheen roughness in 0.01..1.
 */
export type Vec3 = [number, number, number];

const clampR = (r: number) => Math.min(Math.max(r, 0.01), 1);
const clampMu = (mu: number) => Math.min(Math.max(mu, 1e-3), 1);

/** Share of light the sheen layer reflects for a view at cos(theta) = mu. */
export function sheenAlbedo(mu: number, roughness: number): number {
  const x = clampMu(mu);
  const y = clampR(roughness);
  const s = (y * (0.0206607 + 1.58491 * y)) / (0.0379424 + y * (1.32227 + y));
  const m = (y * (-0.193854 + y * (-1.14885 + y * (1.7932 - 0.95943 * y * y)))) / (0.046391 + y);
  const o = (y * (0.000654023 + (-0.0207818 + 0.119681 * y) * y)) / (1.26264 + y * (-1.92021 + y));
  // The fit dips a hair below zero for smooth sheen at normal views.
  return Math.max(Math.exp(-0.5 * ((x - m) / s) ** 2) / (s * Math.sqrt(2 * Math.PI)) + o, 0);
}

/** Inverse LTC scale a^-1. */
export function sheenLtcAInv(mu: number, roughness: number): number {
  const x = clampMu(mu);
  const y = clampR(roughness);
  return ((2.58126 * x + 0.813703 * y) * y) / (1 + 0.310327 * x * x + 2.60994 * x * y);
}

/**
 * Skew of the inverse LTC, b^-1. It is zero at normal incidence, so the lobe is round there and
 * the choice of tangent frame (undefined when V = N) doesn't matter.
 */
export function sheenLtcBInv(mu: number, roughness: number): number {
  const x = clampMu(mu);
  const y = clampR(roughness);
  return (Math.sqrt(1 - x) * (y - 1) * y * y * y) / (0.0000254053 + 1.71228 * x - 1.71506 * x * y + 1.34174 * y * y);
}

/**
 * Normalized sheen lobe over light directions L for view V (both unit, +z up), cosine included:
 * it integrates to 1 over the hemisphere, so radiance = albedo x lobe x light irradiance.
 */
export function sheenLobe(L: Vec3, V: Vec3, roughness: number): number {
  const mu = clampMu(V[2]);
  const vl = Math.hypot(V[0], V[1]);
  const X: Vec3 = vl > 1e-6 ? [V[0] / vl, V[1] / vl, 0] : [1, 0, 0];
  const Y: Vec3 = [-X[1], X[0], 0];
  const wx = L[0] * X[0] + L[1] * X[1];
  const wy = L[0] * Y[0] + L[1] * Y[1];
  const wz = L[2];
  const aInv = sheenLtcAInv(mu, roughness);
  const bInv = sheenLtcBInv(mu, roughness);
  const ox = aInv * wx + bInv * wz;
  const oy = aInv * wy;
  const len2 = ox * ox + oy * oy + wz * wz;
  return (Math.max(wz, 0) / Math.PI) * (aInv / len2) ** 2;
}
