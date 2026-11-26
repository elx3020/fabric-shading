import { describe, expect, it } from 'vitest';
import { bakeWaveNoise, decodeWaveNoise, encodeWaveNoise } from './waveNoise.ts';

const tiles = bakeWaveNoise();
const { size } = tiles;

function channel(layer: number, c: number): Float64Array {
  const out = new Float64Array(size * size);
  for (let t = 0; t < out.length; t++) out[t] = decodeWaveNoise(tiles.data[(layer * size * size + t) * 4 + c]!);
  return out;
}

/** Central rows, where the pole filter does nothing. */
function equatorial(n: Float64Array): number[] {
  const out: number[] = [];
  for (let y = size * 0.375; y < size * 0.625; y++) for (let x = 0; x < size; x++) out.push(n[y * size + x]!);
  return out;
}

/** Mean absolute difference between horizontally adjacent texels, optionally across the wrap only. */
function neighborDiff(n: Float64Array, wrapOnly: boolean): number {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < n.length / size; y++) {
    for (let x = wrapOnly ? size - 1 : 0; x < size; x++) {
      sum += Math.abs(n[y * size + x]! - n[y * size + ((x + 1) % size)]!);
      count++;
    }
  }
  return sum / count;
}

describe('wave noise tiles', () => {
  it('has the expected layout', () => {
    expect(tiles.layers).toBe(16);
    expect(tiles.data.length).toBe(16 * size * size * 4);
  });

  it('round-trips the encoding within one quantization step', () => {
    for (const n of [0, 0.1, 0.5, 1, 2, 4, 7.9]) {
      const step = decodeWaveNoise(encodeWaveNoise(n) + 1) - decodeWaveNoise(encodeWaveNoise(n));
      expect(Math.abs(decodeWaveNoise(encodeWaveNoise(n)) - n)).toBeLessThanOrEqual(step);
    }
  });

  it('keeps mean 1 in every layer and channel, so it preserves lobe energy', () => {
    for (let layer = 0; layer < tiles.layers; layer++) {
      for (let c = 0; c < 3; c++) {
        const n = channel(layer, c);
        const mean = n.reduce((a, b) => a + b, 0) / n.length;
        expect(mean).toBeGreaterThan(0.97);
        expect(mean).toBeLessThan(1.03);
      }
    }
  });

  it('is close to exponentially distributed away from the poles (fully developed speckle)', () => {
    const samples: number[] = [];
    for (let layer = 0; layer < tiles.instances; layer++) samples.push(...equatorial(channel(layer, 0)));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const above2 = samples.filter((v) => v > 2 * mean).length / samples.length;
    // Exponential: P(N > 2) = e^-2 = 0.135, and variance = mean^2.
    expect(above2).toBeGreaterThan(0.09);
    expect(above2).toBeLessThan(0.18);
    const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
    expect(variance / (mean * mean)).toBeGreaterThan(0.7);
    expect(variance / (mean * mean)).toBeLessThan(1.3);
  });

  it('wraps seamlessly: the seam looks like any other pair of neighbors', () => {
    const n = channel(0, 1);
    const inside = neighborDiff(n, false);
    const seam = neighborDiff(n, true);
    expect(seam).toBeLessThan(inside * 1.4);
  });

  it('is smoother toward the poles and in the high-order set', () => {
    const r = channel(0, 0);
    const poleRows = new Float64Array(r.subarray(0, size * 4));
    const midRows = new Float64Array(r.subarray(size * 30, size * 34));
    expect(neighborDiff(poleRows, false)).toBeLessThan(neighborDiff(midRows, false) * 0.6);
    expect(neighborDiff(channel(tiles.instances, 0), false)).toBeLessThan(neighborDiff(channel(0, 0), false) * 0.75);
  });

  it('gives each wavelength its own grain while staying correlated', () => {
    const blue = channel(0, 0);
    const red = channel(0, 2);
    expect(neighborDiff(red, false)).toBeLessThan(neighborDiff(blue, false));
    let cov = 0;
    for (let t = 0; t < blue.length; t++) cov += (blue[t]! - 1) * (red[t]! - 1);
    expect(cov / blue.length).toBeGreaterThan(0.2);
  });

  it('is deterministic per seed and differs between instances', () => {
    expect(bakeWaveNoise({ instances: 2 }).data).toEqual(bakeWaveNoise({ instances: 2 }).data);
    expect(bakeWaveNoise({ instances: 2, seed: 2 }).data).not.toEqual(bakeWaveNoise({ instances: 2 }).data);
    expect(channel(0, 0)).not.toEqual(channel(1, 0));
  });

  it('rejects sizes that are not a power of two', () => {
    expect(() => bakeWaveNoise({ size: 48 })).toThrow(RangeError);
  });
});

