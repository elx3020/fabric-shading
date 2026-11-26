import { Color, DataTexture, DataUtils, HalfFloatType, LinearFilter, MeshBasicNodeMaterial, NearestFilter, RepeatWrapping, RGBAFormat, UnsignedByteType, Vector2, Vector3 } from 'three/webgpu';
import { abs, dot, float, fract, max, mix, normalize, pow, select, sin, sqrt, texture, uniform, uv, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { WeaveMaps } from '@fabric-shading/core';

export const views = ['lit', 'tangent', 'across h', 'along z', 'height', 'occlusion', 'gap', 'yarn id'] as const;
export type View = (typeof views)[number];

/** Uniforms the GUI drives without rebuilding the material. */
export const previewUniforms = {
  /** Repeats across the plane in u and v; v accounts for the repeat's aspect. */
  repeats: uniform(new Vector2(8, 8)),
  lightDir: uniform(new Vector3(0.4, 0.5, 0.75)),
  color: uniform(new Color(0.8, 0.3, 0.15)),
  shininess: uniform(64),
};

export function makeTextures(maps: WeaveMaps): { weave: DataTexture; relief: DataTexture } {
  const half = new Uint16Array(maps.weave.length);
  for (let i = 0; i < half.length; i++) half[i] = DataUtils.toHalfFloat(maps.weave[i]!);
  const weave = new DataTexture(half, maps.size, maps.size, RGBAFormat, HalfFloatType);
  const relief = new DataTexture(maps.relief, maps.size, maps.size, RGBAFormat, UnsignedByteType);
  for (const t of [weave, relief]) {
    t.wrapS = t.wrapT = RepeatWrapping;
    // Tangents and ids must not be blended across yarn edges until the multi-scale tables exist.
    t.magFilter = NearestFilter;
    t.minFilter = NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
  }
  relief.magFilter = LinearFilter;
  return { weave, relief };
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
export function makePreviewMaterial(textures: { weave: DataTexture; relief: DataTexture }, view: View): MeshBasicNodeMaterial {
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
    default: {
      // Plane faces +z, fabric u along x and v along y, so fabric space = world space here.
      const L = normalize(previewUniforms.lightDir);
      const V = vec3(0, 0, 1);
      const H = normalize(L.add(V));
      const across = w.z.mul(2).sub(1);
      // Round yarn cross-section bends the normal across the yarn.
      const side = normalize(vec3(tangent.y.negate(), tangent.x, 0));
      const N0 = normalize(vec3(0, 0, 1).mul(sqrt(max(float(1).sub(across.mul(across)), 0.05))).add(side.mul(across)));
      const diffuse = max(dot(N0, L), 0).mul(0.75).add(0.25);
      const th = dot(tangent, H);
      const spec = pow(sqrt(max(float(1).sub(th.mul(th)), 0)), previewUniforms.shininess).mul(0.6);
      const lit = previewUniforms.color.mul(diffuse).add(spec).mul(r.y);
      color = mix(lit, backdrop, gap);
    }
  }

  const material = new MeshBasicNodeMaterial();
  material.colorNode = color;
  return material;
}
