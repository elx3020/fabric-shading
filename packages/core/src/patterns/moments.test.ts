import { describe, expect, it } from 'vitest';
import { bakeKnitMaps, bakeWeaveMaps } from './bake.ts';
import { defaultKnitParams, jerseyKnit } from './knit.ts';
import { bakeMomentMips, bakeTwoLobeMips } from './moments.ts';
import { defaultWeaveParams, plainWeave, satinWeave } from './weave.ts';

describe('bakeMomentMips', () => {
  const maps = bakeWeaveMaps(satinWeave(5, 2), { ...defaultWeaveParams, crimp: 0 }, { size: 64, aoStrength: 0 });
  const mips = bakeMomentMips(maps);

  it('builds a full chain down to 1x1', () => {
    expect(mips.map((l) => l.size)).toEqual([64, 32, 16, 8, 4, 2, 1]);
  });

  it('keeps the trace at 1 wherever there is yarn', () => {
    for (const level of mips) {
      for (let i = 0; i < level.size * level.size; i++) {
        if (level.a[i * 4 + 3]! === 0) continue;
        const xx = level.a[i * 4]!;
        const yy = level.a[i * 4 + 1]!;
        expect(xx + yy).toBeLessThanOrEqual(1 + 1e-6);
        expect(xx).toBeGreaterThanOrEqual(0);
        expect(yy).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('shows the warp-faced satin as mostly warp (along v) at the coarsest level', () => {
    const top = mips.at(-1)!;
    const xx = top.a[0]!;
    const yy = top.a[1]!;
    expect(yy).toBeGreaterThan(xx);
    expect(xx + yy).toBeCloseTo(1, 5); // no crimp, so tangents are flat
  });

  it('gives a plain weave equal warp and weft at the coarsest level', () => {
    // With crimp the yarns cross over and under, so warp and weft show equally.
    const plain = bakeMomentMips(bakeWeaveMaps(plainWeave(), { ...defaultWeaveParams, irregularity: 0 }, { size: 64, aoStrength: 0 }));
    const top = plain.at(-1)!;
    expect(Math.abs(top.a[0]! - top.a[1]!)).toBeLessThan(0.02);
  });

  it('tracks coverage for open weaves', () => {
    const open = bakeMomentMips(bakeWeaveMaps(plainWeave(), { ...defaultWeaveParams, warpWidth: 0.4, weftWidth: 0.4 }, { size: 64, aoStrength: 0 }));
    expect(open.at(-1)!.a[3]!).toBeLessThan(0.8);
    expect(open.at(-1)!.a[3]!).toBeGreaterThan(0.4);
  });

  it('works on knits and rejects non power-of-two sizes', () => {
    const knit = bakeMomentMips(bakeKnitMaps(jerseyKnit(), defaultKnitParams, { size: 32, aoStrength: 0 }));
    expect(knit.at(-1)!.size).toBe(1);
    const odd = bakeWeaveMaps(plainWeave(), defaultWeaveParams, { size: 48, aoStrength: 0 });
    expect(() => bakeMomentMips(odd)).toThrow(RangeError);
  });
});

describe('bakeTwoLobeMips', () => {
  const maps = bakeWeaveMaps(plainWeave(), { ...defaultWeaveParams, irregularity: 0 }, { size: 64, aoStrength: 0 });
  const one = bakeMomentMips(maps);
  const two = bakeTwoLobeMips(maps);

  it('separates warp (along v) from weft (along u) even where one lobe would average them', () => {
    const top = two.at(-1)!;
    // Crimp tilts tangents out of plane, so the in-plane share is below 1.
    expect(top.a[1]!).toBeGreaterThan(5 * top.a[0]!); // warp: along v
    expect(top.c[0]!).toBeGreaterThan(5 * top.c[1]!); // weft: along u
    expect(one.at(-1)!.a[0]!).toBeLessThan(0.6); // the single lobe is a blur of both
  });

  it('splits coverage and recombines to exactly the single-lobe moment', () => {
    for (let l = 0; l < one.length; l++) {
      const s = one[l]!;
      const d = two[l]!;
      for (let i = 0; i < s.size * s.size; i++) {
        const c0 = d.a[i * 4 + 3]!;
        const c1 = d.c[i * 4 + 3]!;
        expect(c0 + c1).toBeCloseTo(s.a[i * 4 + 3]!, 5);
        if (c0 + c1 === 0) continue;
        const mix = (k: number) => (d.a[i * 4 + k]! * c0 + d.c[i * 4 + k]! * c1) / (c0 + c1);
        for (const k of [0, 1, 2]) expect(mix(k)).toBeCloseTo(s.a[i * 4 + k]!, 4);
        expect((d.b[i * 4]! * c0 + d.b[i * 4 + 2]! * c1) / (c0 + c1)).toBeCloseTo(s.b[i * 4]!, 4);
      }
    }
  });

  it('splits a knit into its two leaning legs', () => {
    const knit = bakeTwoLobeMips(bakeKnitMaps(jerseyKnit(), defaultKnitParams, { size: 64, aoStrength: 0 })).at(-1)!;
    expect(knit.a[3]!).toBeGreaterThan(0.2);
    expect(knit.c[3]!).toBeGreaterThan(0.2);
    // Opposite lean: the off-diagonal Mxy has opposite signs.
    expect(Math.sign(knit.a[2]!)).toBe(-Math.sign(knit.c[2]!));
  });
});
