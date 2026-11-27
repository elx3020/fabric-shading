import { Color, DataArrayTexture, DataTexture, DataUtils, HalfFloatType, LinearFilter, MeshBasicNodeMaterial, NearestFilter, RepeatWrapping, RGBAFormat, UnsignedByteType, Vector2, Vector3 } from 'three/webgpu';
import { abs, cameraPosition, dot, float, floor, fract, int, max, mix, normalize, positionWorld, pow, select, sin, sqrt, texture, uniform, uv, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { deriveYarnNormals, WAVE_NOISE_MAX, type WaveNoiseTiles, type WeaveMaps } from '@fabric-shading/core';

/** Views drawn with the real FabricMaterial (main.ts); the rest are debug views of the baked maps. */
export const materialViews = ['lit (default tier)', 'lit (quality tier, 2 lobes)'] as const;
export const NOISE_VIEW = 'noise tiles (left: glint grain, right: inner grain)';
export const views = [...materialViews, 'lit (unfiltered)', 'tangent', 'across h', 'along z', 'height', 'normals', 'occlusion', 'gap', 'yarn id', NOISE_VIEW] as const;
export type View = (typeof views)[number];

/** Uniforms the GUI drives without rebuilding the material. */
export const previewUniforms = {
  /** Repeats across the plane in u and v; v accounts for the repeat's aspect. */
  repeats: uniform(new Vector2(8, 8)),
  lightDir: uniform(new Vector3(0.4, 0.5, 0.75)),
  color: uniform(new Color(0.8, 0.3, 0.15)),
  shininess: uniform(64),
};


export interface PreviewTextures {
  weave: DataTexture;
  relief: DataTexture;
  normal: DataTexture;
  noise: DataArrayTexture;
  /** Instances per noise set; layers [0, n) reflection, [n, 2n) high-order. */
  noiseInstances: number;
}

/** Noise tiles as an RGBA8 array texture; sampled by direction, so no mipmaps. */
export function makeNoiseTexture(tiles: WaveNoiseTiles): DataArrayTexture {
  const t = new DataArrayTexture(tiles.data, tiles.size, tiles.size, tiles.layers);
  t.format = RGBAFormat;
  t.type = UnsignedByteType;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.magFilter = t.minFilter = LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}




function decodeNoise(v: Node<'vec3'>): Node<'vec3'> {
  return v.mul(v).mul(WAVE_NOISE_MAX);
}

function hash3(p: Node<'vec3'>): Node<'float'> {
  return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
}

/** Direction to noise-tile coordinates: u = azimuth around the yarn, v = longitudinal angle. */




export function makeTextures(maps: WeaveMaps): { weave: DataTexture; relief: DataTexture; normal: DataTexture } {
  const half = new Uint16Array(maps.weave.length);
  for (let i = 0; i < half.length; i++) half[i] = DataUtils.toHalfFloat(maps.weave[i]!);
  const weave = new DataTexture(half, maps.size, maps.size, RGBAFormat, HalfFloatType);
  const relief = new DataTexture(maps.relief, maps.size, maps.size, RGBAFormat, UnsignedByteType);
  const normal = new DataTexture(maps.normal ?? deriveYarnNormals(maps), maps.size, maps.size, RGBAFormat, UnsignedByteType);
  for (const t of [weave, relief, normal]) {
    t.wrapS = t.wrapT = RepeatWrapping;
    // Tangents and ids must not be blended across yarn edges until the multi-scale tables exist.
    t.magFilter = NearestFilter;
    t.minFilter = NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
  }
  relief.magFilter = LinearFilter;
  return { weave, relief, normal };
}

function octDecode(e: Node<'vec2'>): Node<'vec3'> {
  const f = e.mul(2).sub(1);
  const z = float(1).sub(abs(f.x)).sub(abs(f.y));
  const t = max(z.negate(), 0);
  const x = f.x.add(select(f.x.greaterThanEqual(0), t.negate(), t));
  const y = f.y.add(select(f.y.greaterThanEqual(0), t.negate(), t));
  return normalize(vec3(x, y, z));
}

function hashColor(id: Node<'float'>): Node<'vec3'> {
  return fract(sin(vec3(id.mul(12.9898), id.mul(78.233), id.mul(37.719))).mul(43758.5453)).mul(0.7).add(0.3);
}

/**
 * Debug preview: map channels, plus a throwaway Kajiya-Kay style lit view so tangents
 * can be judged by eye. The real fabric material arrives in step 3.
 */
export function makePreviewMaterial(textures: PreviewTextures, view: View): MeshBasicNodeMaterial {
  const st = uv().mul(previewUniforms.repeats);
  const w = texture(textures.weave, st);
  const r = texture(textures.relief, st);
  const tangent = octDecode(w.xy);
  const gap = r.z;
  const backdrop = vec3(0.05);

  let color: Node<'vec3'>;
  switch (view) {
    case 'tangent':
      color = tangent.mul(0.5).add(0.5);
      break;
    case 'across h':
      color = vec3(w.z);
      break;
    case 'along z':
      color = vec3(w.w);
      break;
    case 'height':
      color = vec3(r.x);
      break;
    case 'normals':
      // The usual normal-map colours: x to red, y to green, up is blue.
      color = texture(textures.normal, st).rgb;
      break;
    case 'occlusion':
      color = vec3(r.y);
      break;
    case 'gap':
      color = vec3(gap);
      break;
    case 'yarn id': {
      const packed = r.w.mul(255).round();
      color = mix(hashColor(packed.add(1)), backdrop, gap);
      break;
    }
    case NOISE_VIEW: {
      // Left half: reflection set, right half: high-order set; one instance per repeat.
      const cell = floor(st);
      const set = floor(uv().x.mul(2)).mul(textures.noiseInstances);
      const layer = int(set.add(floor(hash3(vec3(cell, 0)).mul(textures.noiseInstances))));
      color = decodeNoise(texture(textures.noise, fract(st)).depth(layer).rgb).mul(0.35);
      break;
    }
    default: {
      // Plane faces +z, fabric u along x and v along y, so fabric space = world space here.
      const L = normalize(previewUniforms.lightDir);
      const V = normalize(cameraPosition.sub(positionWorld));
      const H = normalize(L.add(V));
      // The baked yarn normal bends across the yarn cross-section.
      const N0 = normalize(texture(textures.normal, st).xyz.mul(2).sub(1));
      const diffuse = max(dot(N0, L), 0).mul(0.75).add(0.25);
      const th = dot(tangent, H);
      const spec = pow(sqrt(max(float(1).sub(th.mul(th)), 0)), previewUniforms.shininess).mul(0.6);
      const lit = previewUniforms.color.mul(diffuse).add(spec).mul(r.y);
      color = mix(lit, backdrop, gap);
    }
  }

  const material = new MeshBasicNodeMaterial();
  material.colorNode = color;
  // Debug views show raw values; only the lit material views are tone mapped.
  material.toneMapped = false;
  return material;
}
