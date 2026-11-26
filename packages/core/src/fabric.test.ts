import { describe, expect, it } from 'vitest';
import { decodeFabric, encodeFabric } from './asset/fabricFile.ts';
import { bakeFabric, fabricFromPreset, fabricPresetIds, srgbToLinear, yarnDiameterUm } from './fabric.ts';
import { plainWeave } from './patterns/weave.ts';
import type { YarnData } from './presets.ts';

describe('bakeFabric', () => {
  it('derives physical shading inputs from the pattern and yarn', () => {
    const asset = bakeFabric({
      kind: 'woven',
      pattern: plainWeave(),
      params: { warpWidth: 0.5, weftWidth: 0.5 },
      color: [1, 0.5, 0],
      yarn: { plies: 1, plyDiameterUm: 100, fibersPerPly: [20, 20], fiberDiameterUm: 12, twistPitchUm: 1000, ior: 1.6 },
      bake: { size: 64 },
      noise: { size: 16, instances: 2 },
    });
    const s = asset.shading!;
    expect(s.threadSpacingUm).toBeCloseTo(200);
    expect(s.gapHalfWidthUm[0]).toBeCloseTo(50);
    expect(s.beamRatio[0]).toBeCloseTo(2);
    expect(s.albedo[1]).toBeCloseTo(srgbToLinear(0.5));
    expect(s.gapFraction).toBeGreaterThan(0.1);
    expect(asset.yarn?.ior).toBe(1.6);
    expect(asset.twoLobes?.length).toBe(asset.moments.length);
  });

  it('bakes every preset', () => {
    for (const id of fabricPresetIds) {
      const a = fabricFromPreset(id, { bake: { size: 32 }, noise: { size: 8, instances: 1 } });
      expect(a.shading!.threadSpacingUm).toBeGreaterThan(0);
      expect(Number.isFinite(a.shading!.beamRatio[0])).toBe(true);
    }
  });

  it('keeps shading and yarn data through a file round trip', () => {
    const asset = fabricFromPreset(fabricPresetIds[0]!, { bake: { size: 32 }, noise: { size: 8, instances: 1 } });
    const back = decodeFabric(encodeFabric(asset));
    expect(back.shading).toEqual(asset.shading);
    expect(back.yarn).toEqual(asset.yarn);
  });

  it('estimates yarn diameter from plies', () => {
    const yarn: YarnData = { plies: 1, plyDiameterUm: 100, fibersPerPly: [20, 20], fiberDiameterUm: 12, twistPitchUm: 1000, ior: 1.5 };
    expect(yarnDiameterUm(yarn)).toBe(100);
    expect(yarnDiameterUm({ ...yarn, plies: 2 })).toBe(200);
  });
});
