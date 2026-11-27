import { describe, expect, it } from 'vitest';
import { bakeKnitMaps, bakeWeaveMaps, decodeYarnId, deriveYarnNormals } from './bake.ts';
import { defaultKnitParams, jerseyKnit } from './knit.ts';
import { octDecode, octEncode, type Vec3 } from './octahedral.ts';
import { defaultWeaveParams, plainWeave, satinWeave, YarnKind, yarnNormal } from './weave.ts';

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

describe('yarn normals', () => {
  const decode = (n: Uint8Array, i: number): Vec3 => [n[i * 4]! / 127.5 - 1, n[i * 4 + 1]! / 127.5 - 1, n[i * 4 + 2]! / 127.5 - 1];

  it('are perpendicular to the yarn tangent and face up', () => {
    const t: Vec3 = [0, 0.9 / Math.hypot(0.9, 0.436), 0.436 / Math.hypot(0.9, 0.436)];
    for (const h of [-0.95, -0.5, 0, 0.5, 0.95]) {
      const n = yarnNormal(t, [1, 0, 0], h, 0.6);
      expect(Math.hypot(...n)).toBeCloseTo(1, 6);
      expect(n[0] * t[0] + n[1] * t[1] + n[2] * t[2]).toBeCloseTo(0, 6);
      expect(n[2]).toBeGreaterThan(0);
      expect(Math.sign(n[0])).toBe(Math.sign(h) || 0);
    }
  });

  it('tilt toward the yarn edges across a warp and stay up in the gaps', () => {
    const maps = bakeWeaveMaps(plainWeave(), { ...defaultWeaveParams, warpWidth: 0.5, weftWidth: 0.5, irregularity: 0 }, { size: 64, aoStrength: 0 });
    let gapsUp = true;
    let tilted = 0;
    for (let i = 0; i < 64 * 64; i++) {
      const n = decode(maps.normal!, i);
      if (maps.relief[i * 4 + 2]! > 127) gapsUp &&= n[2] > 0.99;
      else if (Math.hypot(n[0], n[1]) > 0.5) tilted++;
    }
    expect(gapsUp).toBe(true);
    expect(tilted).toBeGreaterThan(0);
  });

  it('can be rebuilt from older maps', () => {
    const maps = bakeWeaveMaps(plainWeave(), { ...defaultWeaveParams, flatness: 1, irregularity: 0 }, { size: 32, aoStrength: 0 });
    const derived = deriveYarnNormals(maps);
    let worst = 0;
    for (let i = 0; i < 32 * 32; i++) {
      const a = decode(maps.normal!, i);
      const b = decode(derived, i);
      worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
    expect(worst).toBeLessThan(0.05);
  });

  it('are baked for knits too', () => {
    const maps = bakeKnitMaps(jerseyKnit(), defaultKnitParams, { size: 32, aoStrength: 0 });
    expect(maps.normal!.length).toBe(32 * 32 * 4);
  });
});
