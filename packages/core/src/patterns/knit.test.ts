import { describe, expect, it } from 'vitest';
import { bakeKnitMaps, decodeYarnId } from './bake.ts';
import { defaultKnitParams, garterKnit, jerseyKnit, knitAspect, knitSampler, ribKnit, seedKnit, type KnitParams } from './knit.ts';
import { YarnKind } from './weave.ts';

const smooth: KnitParams = { ...defaultKnitParams, irregularity: 0 };

describe('knit patterns', () => {
  it('builds the expected stitch layouts', () => {
    expect(jerseyKnit(true).stitches).toEqual([['K']]);
    expect(jerseyKnit(false).stitches).toEqual([['P']]);
    expect(ribKnit(2, 2).stitches).toEqual([['K', 'K', 'P', 'P']]);
    expect(garterKnit().stitches).toEqual([['K'], ['P']]);
    expect(seedKnit().stitches).toEqual([
      ['K', 'P'],
      ['P', 'K'],
    ]);
  });

  it('rejects empty ribs', () => {
    expect(() => ribKnit(0, 1)).toThrow(RangeError);
  });

  it('reports the physical aspect of the repeat', () => {
    expect(knitAspect(ribKnit(2, 2), { ...smooth, stitchAspect: 1.25 })).toBeCloseTo(5);
    expect(knitAspect(garterKnit(), { ...smooth, stitchAspect: 1.3 })).toBeCloseTo(0.65);
  });
});

describe('knitSampler', () => {
  it('shows a leg near the middle height of a knit stitch, angled upward', () => {
    const sample = knitSampler(jerseyKnit(true), smooth);
    // Left leg of the V sits left of centre at mid height.
    const s = sample(0.25, 0.45);
    expect(s.kind).toBe(YarnKind.Loop);
    expect(Math.abs(s.tangent[1])).toBeGreaterThan(Math.abs(s.tangent[0]));
  });

  it('shows mostly horizontal yarn on the purl side', () => {
    const sample = knitSampler(jerseyKnit(false), smooth);
    let horizontal = 0;
    let total = 0;
    for (let i = 0; i < 400; i++) {
      const s = sample(((i * 0.137) % 1), ((i * 0.291) % 1));
      if (s.kind === YarnKind.None) continue;
      total++;
      if (Math.abs(s.tangent[0]) > Math.abs(s.tangent[1])) horizontal++;
    }
    expect(horizontal / total).toBeGreaterThan(0.5);
  });

  it('is face and back of the same fabric: purl heights mirror knit heights', () => {
    const k = knitSampler(jerseyKnit(true), smooth);
    const p = knitSampler(jerseyKnit(false), smooth);
    // At the centre of a leg the knit side is high; the purl side shows it buried.
    expect(k(0.25, 0.45).height).toBeGreaterThan(p(0.25, 0.45).height);
  });

  it('returns unit tangents, h within -1..1 and z within the repeat', () => {
    const sample = knitSampler(seedKnit(), defaultKnitParams);
    for (let i = 0; i < 300; i++) {
      const s = sample(((i * 0.0731) % 1), ((i * 0.1913) % 1));
      if (s.kind === YarnKind.None) continue;
      expect(Math.hypot(...s.tangent)).toBeCloseTo(1, 6);
      expect(Math.abs(s.h)).toBeLessThanOrEqual(1);
      expect(s.z).toBeGreaterThanOrEqual(0);
      expect(s.z).toBeLessThan(1);
    }
  });

  it('tiles seamlessly across the repeat edge', () => {
    const sample = knitSampler(ribKnit(1, 1), smooth);
    for (const v of [0.1, 0.4, 0.8]) {
      const a = sample(1e-6, v);
      const b = sample(1 - 1e-6, v);
      expect(a.height).toBeCloseTo(b.height, 2);
    }
  });
});

describe('bakeKnitMaps', () => {
  it('covers most of a garter fabric with yarn and stores course ids', () => {
    const maps = bakeKnitMaps(garterKnit(), smooth, { size: 64, aoStrength: 0.5 });
    expect(maps.knitted).toBe(true);
    let covered = 0;
    const ids = new Set<number>();
    for (let i = 0; i < 64 * 64; i++) {
      const d = decodeYarnId(maps.relief[i * 4 + 3]!, maps.relief[i * 4 + 2]!, true);
      if (d.kind !== YarnKind.None) {
        covered++;
        ids.add(d.yarnId);
      }
    }
    expect(covered / (64 * 64)).toBeGreaterThan(0.85);
    expect([...ids].sort()).toEqual([0, 1]);
  });
});
