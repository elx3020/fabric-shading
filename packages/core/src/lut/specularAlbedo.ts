/**
 * Directional albedo of the fiber specular lobe, for image-based lighting.
 *
 * An environment map lights the cloth from every direction, so its specular contribution is
 * the prefiltered radiance times the share of light the lobe reflects toward the viewer:
 *
 *   E(mu_v, alpha) = integral over the hemisphere of f_spec(L, V) F(V.H) cos(theta_L) dL
 *
 * with the same SGGX microflake slab (Jin et al.) and Fresnel as the direct lights. E is small
 * (1 to 4% for polymer fibers) and grows only gently toward grazing, because the slab's flakes
 * are fiber surfaces, not one smooth plane: Fresnel on the macro normal would wrongly reflect
 * most of the environment at grazing angles.
 *
 * A second channel holds the same integral without Fresnel, for the light that passes through
 * a clear fiber and leaves toward the viewer tinted by the fiber (Zhu et al.'s TT lobe), which
 * is weighted per colour channel at runtime.
 *
 * The fabric-wide mean tangent moment (the last mip) stands in for the per-pixel one, and the
 * view azimuth is averaged, so one small table per fabric covers every roughness.
 */
import { fiberSggx, sggxSpecular, type Sym3 } from '../shading/sggx.ts';
import { fresnel } from './yarnScattering.ts';

export interface SpecularAlbedoLut {
  /** Samples over cos(theta_v), sample i at mu = (i + 0.5) / muSamples. */
  muSamples: number;
  /** Samples over fiber roughness alpha, sample j at alpha = (j + 0.5) / alphaSamples. */
  alphaSamples: number;
  /** muSamples x alphaSamples values, row-major by alpha: the albedo with Fresnel. */
  data: Float32Array;
  /** The same without Fresnel (the bare lobe albedo). */
  bare: Float32Array;
}

export function bakeSpecularAlbedo(
  moment: Sym3,
  { ior = 1.55, thickness = 2, muSamples = 16, alphaSamples = 8, steps = 16 } = {},
): SpecularAlbedoLut {
  const data = new Float32Array(muSamples * alphaSamples);
  const bare = new Float32Array(muSamples * alphaSamples);
  const azimuths = 2;
  for (let j = 0; j < alphaSamples; j++) {
    const s = fiberSggx(moment, (j + 0.5) / alphaSamples);
    for (let i = 0; i < muSamples; i++) {
      const muV = (i + 0.5) / muSamples;
      const sinV = Math.sqrt(1 - muV * muV);
      let e = 0;
      let eb = 0;
      for (let a = 0; a < azimuths; a++) {
        const phiV = ((a + 0.5) / azimuths) * Math.PI; // the lobe is symmetric under phi + pi
        const V: [number, number, number] = [sinV * Math.cos(phiV), sinV * Math.sin(phiV), muV];
        // Integrate over L with d(omega) = d(mu) d(phi), cosine-free since f * mu_L is wanted.
        for (let k = 0; k < steps; k++) {
          const muL = (k + 0.5) / steps;
          const sinL = Math.sqrt(1 - muL * muL);
          for (let p = 0; p < 2 * steps; p++) {
            const phi = ((p + 0.5) / (2 * steps)) * 2 * Math.PI;
            const L: [number, number, number] = [sinL * Math.cos(phi), sinL * Math.sin(phi), muL];
            const hx = L[0] + V[0];
            const hy = L[1] + V[1];
            const hz = L[2] + V[2];
            const vh = (V[0] * hx + V[1] * hy + V[2] * hz) / Math.hypot(hx, hy, hz);
            const lobe = sggxSpecular(s, L, V, thickness) * muL;
            e += lobe * fresnel(ior, vh);
            eb += lobe;
          }
        }
      }
      data[j * muSamples + i] = (e * (1 / steps) * (Math.PI / steps)) / azimuths;
      bare[j * muSamples + i] = (eb * (1 / steps) * (Math.PI / steps)) / azimuths;
    }
  }
  return { muSamples, alphaSamples, data, bare };
}
