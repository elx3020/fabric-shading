import { describe, expect, it } from 'vitest';
import { bakeTwoLayerLut } from '../lut/twoLayer.ts';
import { bakeWaveNoise } from '../noise/waveNoise.ts';
import { bakeWeaveMaps } from '../patterns/bake.ts';
import { bakeMomentMips } from '../patterns/moments.ts';
import { defaultWeaveParams, twillWeave } from '../patterns/weave.ts';
import { decodeFabric, encodeFabric, readFabric, writeFabric, type FabricAsset } from './fabricFile.ts';
import { fromHalf, toHalf } from './half.ts';

function sampleAsset(): FabricAsset {
  const maps = bakeWeaveMaps(twillWeave(2, 1), defaultWeaveParams, { size: 64, aoStrength: 0.6 });
  return {
    name: 'test twill',
    settings: { weave: 'twill', color: '#336699', nested: { a: [1, 2] } },
    maps,
    moments: bakeMomentMips(maps),
    twoLayer: bakeTwoLayerLut({ gapFraction: 0.05 }),
    noise: bakeWaveNoise({ size: 16, instances: 2 }),
  };
}

function expectClose(a: Float32Array, b: Float32Array): void {
  expect(b.length).toBe(a.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThanOrEqual(Math.abs(a[i]!) * 1e-3 + 1e-4);
}

describe('half floats', () => {
  it('round-trips representative values', () => {
    for (const v of [0, 1, -1, 0.5, 0.333, 65504, 1e-5, -2.75]) expect(fromHalf(toHalf(v))).toBeCloseTo(v, Math.abs(v) > 100 ? -1 : 3);
    expect(fromHalf(toHalf(1e6))).toBe(Infinity);
  });
});

describe('fabric file', () => {
  it('round-trips every part of an asset', () => {
    const asset = sampleAsset();
    const back = decodeFabric(encodeFabric(asset));
    expect(back.name).toBe(asset.name);
    expect(back.settings).toEqual(asset.settings);
    expect(back.maps.size).toBe(64);
    expect(back.maps.aspect).toBe(asset.maps.aspect);
    expect(back.maps.knitted).toBe(false);
    expectClose(asset.maps.weave, back.maps.weave);
    expect(back.maps.relief).toEqual(asset.maps.relief);
    expect(back.moments.map((m) => m.size)).toEqual(asset.moments.map((m) => m.size));
    asset.moments.forEach((m, i) => {
      expectClose(m.a, back.moments[i]!.a);
      expectClose(m.b, back.moments[i]!.b);
    });
    expectClose(asset.twoLayer.data, back.twoLayer.data);
    expect(back.noise.data).toEqual(asset.noise.data);
    expect(back.noise.layers).toBe(4);
  });

  it('compresses with gzip and reads both compressed and raw files', async () => {
    const asset = sampleAsset();
    const raw = encodeFabric(asset);
    const zipped = await writeFabric(asset);
    expect(zipped[0]).toBe(0x1f);
    expect(zipped.byteLength).toBeLessThan(raw.byteLength);
    expect((await readFabric(zipped)).maps.relief).toEqual(asset.maps.relief);
    expect((await readFabric(raw)).name).toBe('test twill');
  });

  it('rejects other files, newer versions and truncated data', () => {
    expect(() => decodeFabric(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toThrow('Not a fabric file');
    const bytes = encodeFabric(sampleAsset());
    const newer = bytes.slice();
    new DataView(newer.buffer).setUint32(4, 99, true);
    expect(() => decodeFabric(newer)).toThrow('newer');
    expect(() => decodeFabric(bytes.subarray(0, bytes.byteLength - 100))).toThrow('truncated');
  });
});
