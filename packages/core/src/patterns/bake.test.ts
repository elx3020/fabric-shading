import { describe, expect, it } from 'vitest';
import { bakeWeaveMaps, decodeYarnId } from './bake.ts';
import { octDecode, octEncode, type Vec3 } from './octahedral.ts';
import { defaultWeaveParams, plainWeave, satinWeave, YarnKind } from './weave.ts';

describe('octahedral encoding', () => {
  it('round-trips directions on both hemispheres', () => {
    const dirs: Vec3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [0, 0, -1],
      [0.3, -0.5, 0.81],
      [-0.6, 0.2, -0.77],
    ];
    for (const d of dirs) {
      const l = Math.hypot(...d);
      const n: Vec3 = [d[0] / l, d[1] / l, d[2] / l];
      const r = octDecode(octEncode(n));
      for (let k = 0; k < 3; k++) expect(r[k]).toBeCloseTo(n[k]!, 5);
    }
  });
});

describe('bakeWeaveMaps', () => {
  it('fills both maps at the requested size', () => {
    const maps = bakeWeaveMaps(plainWeave(), defaultWeaveParams, { size: 32, aoStrength: 0.5 });
    expect(maps.weave.length).toBe(32 * 32 * 4);
    expect(maps.relief.length).toBe(32 * 32 * 4);
    for (const value of maps.weave) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('marks gaps for open weaves and stores decodable yarn ids', () => {
    const maps = bakeWeaveMaps(plainWeave(), { ...defaultWeaveParams, warpWidth: 0.4, weftWidth: 0.4 }, { size: 64, aoStrength: 0.5 });
    let gaps = 0;
    for (let i = 0; i < 64 * 64; i++) {
      const gap = maps.relief[i * 4 + 2]!;
      const id = decodeYarnId(maps.relief[i * 4 + 3]!, gap);
      if (id.kind === YarnKind.None) gaps++;
      else expect(id.yarnId).toBeLessThan(2);
    }
    // 0.6 x 0.6 of each cell is open.
    expect(gaps / (64 * 64)).toBeCloseTo(0.36, 1);
  });

  it('shows mostly warp on a warp-faced satin', () => {
    const maps = bakeWeaveMaps(satinWeave(5, 2, true), { ...defaultWeaveParams, irregularity: 0 }, { size: 80, aoStrength: 0.5 });
    let warp = 0;
    for (let i = 0; i < 80 * 80; i++) {
      if (decodeYarnId(maps.relief[i * 4 + 3]!, maps.relief[i * 4 + 2]!).kind === YarnKind.Warp) warp++;
    }
    expect(warp / (80 * 80)).toBeGreaterThan(0.6);
  });

  it('rejects unusable sizes', () => {
    expect(() => bakeWeaveMaps(plainWeave(), defaultWeaveParams, { size: 4, aoStrength: 0 })).toThrow(RangeError);
  });
});
