import { describe, expect, it } from 'vitest';
import { sheenAlbedo, sheenLobe, type Vec3 } from './sheen.ts';

function integrate(V: Vec3, r: number, steps = 96): number {
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const mu = (i + 0.5) / steps;
    const s = Math.sqrt(1 - mu * mu);
    for (let j = 0; j < 2 * steps; j++) {
      const phi = ((j + 0.5) / (2 * steps)) * 2 * Math.PI;
      sum += sheenLobe([s * Math.cos(phi), s * Math.sin(phi), mu], V, r);
    }
  }
  return (sum * (1 / steps) * (Math.PI / steps));
}

describe('sheen layer', () => {
  it('has a lobe that integrates to about one over the hemisphere', () => {
    for (const r of [0.2, 0.5, 0.9]) {
      for (const mu of [0.2, 0.6, 1]) {
        const V: Vec3 = [Math.sqrt(1 - mu * mu), 0, mu];
        expect(integrate(V, r)).toBeGreaterThan(0.85);
        expect(integrate(V, r)).toBeLessThan(1.05);
      }
    }
  });

  it('reflects a bounded share that grows toward grazing views for rough fuzz', () => {
    for (const r of [0.1, 0.3, 0.6, 1]) {
      for (let mu = 0.05; mu <= 1; mu += 0.05) {
        const a = sheenAlbedo(mu, r);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThan(1);
      }
    }
    expect(sheenAlbedo(0.1, 0.6)).toBeGreaterThan(sheenAlbedo(1, 0.6));
  });

  it('sends light back toward grazing directions', () => {
    const V: Vec3 = [Math.sqrt(1 - 0.04), 0, 0.2];
    const back = sheenLobe([Math.sqrt(1 - 0.04), 0, 0.2], V, 0.5);
    const top = sheenLobe([0, 0, 1], V, 0.5);
    expect(back).toBeGreaterThan(top);
  });

  it('is continuous through the head-on view, whatever side the viewer leans to', () => {
    // Near V = N the tangent frame flips with the view's azimuth; the lobe must not.
    const e = 0.01;
    const L: Vec3 = [0.6, 0.3, Math.sqrt(1 - 0.45)];
    for (const r of [0.3, 0.6, 1]) {
      const a = sheenLobe(L, [e, 0, Math.sqrt(1 - e * e)], r);
      const b = sheenLobe(L, [-e, 0, Math.sqrt(1 - e * e)], r);
      expect(Math.abs(a - b)).toBeLessThan(0.1 * a);
    }
  });
});
