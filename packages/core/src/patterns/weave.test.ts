import { describe, expect, it } from 'vitest';
import { defaultWeaveParams, plainWeave, sampleWeave, satinWeave, twillWeave, YarnKind, type WeaveParams } from './weave.ts';

const count = (row: readonly boolean[]) => row.filter(Boolean).length;

describe('weave patterns', () => {
  it('plain weave alternates in both directions', () => {
    const p = plainWeave();
    expect(p.warpUp).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it('2/2 twill floats two over two under and steps one end per pick', () => {
    const p = twillWeave(2, 2);
    expect(p.rows).toBe(4);
    for (const row of p.warpUp) expect(count(row)).toBe(2);
    for (let r = 1; r < p.rows; r++) {
      const prev = p.warpUp[r - 1]!;
      const shifted = prev.map((_, c) => prev[(c - 1 + p.cols) % p.cols]!);
      expect(p.warpUp[r]).toEqual(shifted);
    }
  });

  it('satin has exactly one interlacing per row and per column', () => {
    const p = satinWeave(5, 2, true);
    for (const row of p.warpUp) expect(count(row)).toBe(4);
    for (let c = 0; c < p.cols; c++) expect(p.warpUp.filter((row) => !row[c]).length).toBe(1);
  });

  it('rejects a satin step that is not coprime with the repeat', () => {
    expect(() => satinWeave(6, 2)).toThrow(RangeError);
    expect(() => satinWeave(4, 2)).toThrow(RangeError);
  });
});

describe('sampleWeave', () => {
  const smooth: WeaveParams = { ...defaultWeaveParams, irregularity: 0 };

  it('shows the yarn the pattern puts on top at each cell centre', () => {
    for (const pattern of [plainWeave(), twillWeave(2, 1), satinWeave(5, 2)]) {
      for (let r = 0; r < pattern.rows; r++) {
        for (let c = 0; c < pattern.cols; c++) {
          const s = sampleWeave(pattern, smooth, (c + 0.5) / pattern.cols, (r + 0.5) / pattern.rows);
          expect(s.kind).toBe(pattern.warpUp[r]![c] ? YarnKind.Warp : YarnKind.Weft);
        }
      }
    }
  });

  it('leaves gaps between narrow yarns and none when yarns fill the cell', () => {
    const corner = (w: number) => sampleWeave(plainWeave(), { ...smooth, warpWidth: w, weftWidth: w }, 0.01, 0.01).kind;
    expect(corner(0.5)).toBe(YarnKind.None);
    expect(corner(1)).not.toBe(YarnKind.None);
  });

  it('returns unit tangents along the yarn direction', () => {
    const p = twillWeave(2, 2);
    for (let i = 0; i < 200; i++) {
      const s = sampleWeave(p, defaultWeaveParams, (i * 0.137) % 1, (i * 0.291) % 1);
      if (s.kind === YarnKind.None) continue;
      expect(Math.hypot(...s.tangent)).toBeCloseTo(1, 6);
      if (s.kind === YarnKind.Warp) expect(s.tangent[0]).toBe(0);
      else expect(s.tangent[1]).toBe(0);
    }
  });

  it('keeps h within -1..1 and z within the repeat', () => {
    const p = satinWeave(8, 3);
    for (let i = 0; i < 500; i++) {
      const s = sampleWeave(p, defaultWeaveParams, (i * 0.0731) % 1, (i * 0.1913) % 1);
      expect(Math.abs(s.h)).toBeLessThanOrEqual(1);
      expect(s.z).toBeGreaterThanOrEqual(0);
      expect(s.z).toBeLessThan(1);
    }
  });

  it('tilts the tangent where a yarn dives under its neighbour', () => {
    // Plain weave warp at column 0 goes from up (row 0) to down (row 1): slope is negative between them.
    const s = sampleWeave(plainWeave(), smooth, 0.25, 0.5);
    expect(s.kind).toBe(YarnKind.Warp);
    expect(s.tangent[2]).toBeLessThan(0);
  });

  it('is deterministic for a given seed and changes with it', () => {
    const p = twillWeave(2, 2);
    const a = sampleWeave(p, { ...defaultWeaveParams, irregularity: 1, seed: 3 }, 0.37, 0.61);
    const b = sampleWeave(p, { ...defaultWeaveParams, irregularity: 1, seed: 3 }, 0.37, 0.61);
    const c = sampleWeave(p, { ...defaultWeaveParams, irregularity: 1, seed: 4 }, 0.37, 0.61);
    expect(a).toEqual(b);
    expect(a.h).not.toBe(c.h);
  });
});
