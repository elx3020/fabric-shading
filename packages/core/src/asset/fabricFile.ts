import type { TwoLayerLut } from '../lut/twoLayer.ts';
import type { WaveNoiseTiles } from '../noise/waveNoise.ts';
import type { WeaveMaps } from '../patterns/bake.ts';
import type { MomentLevel, TwoLobeLevel } from '../patterns/moments.ts';
import { packHalf, unpackHalf } from './half.ts';

/**
 * A baked fabric: everything the material needs at runtime, plus the editor settings that
 * produced it so the editor can reopen it. The diffraction table is the same for every fabric
 * and is not stored.
 *
 * File layout (little endian), usually gzip-compressed on disk as `.fabric`:
 *
 *   "FBRC"  u32 version  u32 headerBytes  header (UTF-8 JSON)  padding to 4 bytes  chunks
 *
 * The header lists each chunk's offset (from the start of the chunk area), byte length and
 * element type. Float data is stored as half floats, which is what the GPU textures use anyway.
 */
export interface FabricAsset {
  name: string;
  /** Free-form editor state (pattern, sliders, colour); the material ignores it. */
  settings: Record<string, unknown>;
  maps: WeaveMaps;
  moments: MomentLevel[];
  /** Quality-tier specular; optional because the default tier does not need it. */
  twoLobes?: TwoLobeLevel[];
  twoLayer: TwoLayerLut;
  noise: WaveNoiseTiles;
}

export const FABRIC_FILE_VERSION = 1;
const MAGIC = 0x43524246; // "FBRC" read as little-endian u32

interface ChunkInfo {
  id: string;
  type: 'f16' | 'u8';
  offset: number;
  bytes: number;
}

interface Header {
  name: string;
  settings: Record<string, unknown>;
  size: number;
  aspect: number;
  knitted: boolean;
  momentSizes: number[];
  twoLobeSizes?: number[];
  twoLayerSamples: number;
  noise: { size: number; instances: number; layers: number };
  chunks: ChunkInfo[];
}

const align4 = (n: number) => (n + 3) & ~3;

export function encodeFabric(asset: FabricAsset): Uint8Array {
  const parts: { info: ChunkInfo; data: Uint8Array }[] = [];
  let offset = 0;
  const add = (id: string, data: Float32Array | Uint8Array) => {
    const bytes =
      data instanceof Float32Array ? new Uint8Array(packHalf(data).buffer) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    parts.push({ info: { id, type: data instanceof Float32Array ? 'f16' : 'u8', offset, bytes: bytes.byteLength }, data: bytes });
    offset = align4(offset + bytes.byteLength);
  };

  add('weave', asset.maps.weave);
  add('relief', asset.maps.relief);
  asset.moments.forEach((level, i) => {
    add(`moment.a.${i}`, level.a);
    add(`moment.b.${i}`, level.b);
  });
  asset.twoLobes?.forEach((level, i) => {
    add(`lobes.a.${i}`, level.a);
    add(`lobes.b.${i}`, level.b);
    add(`lobes.c.${i}`, level.c);
  });
  add('twoLayer', asset.twoLayer.data);
  add('noise', asset.noise.data);

  const header: Header = {
    name: asset.name,
    settings: asset.settings,
    size: asset.maps.size,
    aspect: asset.maps.aspect,
    knitted: asset.maps.knitted,
    momentSizes: asset.moments.map((m) => m.size),
    ...(asset.twoLobes ? { twoLobeSizes: asset.twoLobes.map((m) => m.size) } : {}),
    twoLayerSamples: asset.twoLayer.samples,
    noise: { size: asset.noise.size, instances: asset.noise.instances, layers: asset.noise.layers },
    chunks: parts.map((p) => p.info),
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const chunkStart = align4(12 + json.byteLength);
  const out = new Uint8Array(chunkStart + offset);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, FABRIC_FILE_VERSION, true);
  view.setUint32(8, json.byteLength, true);
  out.set(json, 12);
  for (const p of parts) out.set(p.data, chunkStart + p.info.offset);
  return out;
}

export function decodeFabric(bytes: Uint8Array): FabricAsset {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || view.getUint32(0, true) !== MAGIC) throw new Error('Not a fabric file');
  const version = view.getUint32(4, true);
  if (version > FABRIC_FILE_VERSION) throw new Error(`Fabric file version ${version} is newer than this library (${FABRIC_FILE_VERSION})`);
  const jsonBytes = view.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + jsonBytes))) as Header;
  const chunkStart = align4(12 + jsonBytes);

  const chunk = (id: string): ChunkInfo => {
    const c = header.chunks.find((x) => x.id === id);
    if (!c) throw new Error(`Fabric file is missing chunk "${id}"`);
    if (chunkStart + c.offset + c.bytes > bytes.byteLength) throw new Error(`Fabric file is truncated in chunk "${id}"`);
    return c;
  };
  // Copy each chunk so the typed arrays are aligned and independent of the file buffer.
  const floats = (id: string): Float32Array => {
    const c = chunk(id);
    const copy = bytes.slice(chunkStart + c.offset, chunkStart + c.offset + c.bytes);
    return unpackHalf(new Uint16Array(copy.buffer));
  };
  const u8 = (id: string): Uint8Array => {
    const c = chunk(id);
    return bytes.slice(chunkStart + c.offset, chunkStart + c.offset + c.bytes);
  };

  return {
    name: header.name,
    settings: header.settings,
    maps: { size: header.size, aspect: header.aspect, knitted: header.knitted, weave: floats('weave'), relief: u8('relief') },
    moments: header.momentSizes.map((size, i) => ({ size, a: floats(`moment.a.${i}`), b: floats(`moment.b.${i}`) })),
    ...(header.twoLobeSizes
      ? { twoLobes: header.twoLobeSizes.map((size, i) => ({ size, a: floats(`lobes.a.${i}`), b: floats(`lobes.b.${i}`), c: floats(`lobes.c.${i}`) })) }
      : {}),
    twoLayer: { samples: header.twoLayerSamples, data: floats('twoLayer') },
    noise: { ...header.noise, data: u8('noise') },
  };
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const piped = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

/** Encodes and gzips an asset, ready to save as a `.fabric` file. */
export async function writeFabric(asset: FabricAsset): Promise<Uint8Array> {
  return pipe(encodeFabric(asset), new CompressionStream('gzip'));
}

/** Reads a `.fabric` file, compressed or not. */
export async function readFabric(bytes: Uint8Array): Promise<FabricAsset> {
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  return decodeFabric(gzipped ? await pipe(bytes, new DecompressionStream('gzip')) : bytes);
}
