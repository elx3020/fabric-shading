import { Color, DataTexture, DataUtils, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, MeshBasicNodeMaterial, NearestFilter, RepeatWrapping, RGBAFormat, UnsignedByteType, Vector2, Vector3 } from 'three/webgpu';
import { abs, cameraPosition, dot, exp, float, fract, max, mix, normalize, positionWorld, pow, select, sin, sqrt, texture, uniform, uv, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { MomentLevel, WeaveMaps } from '@fabric-shading/core';

export const views = ['lit (SGGX, filtered)', 'lit (unfiltered)', 'tangent', 'across h', 'along z', 'height', 'occlusion', 'gap', 'yarn id'] as const;
export type View = (typeof views)[number];

/** Uniforms the GUI drives without rebuilding the material. */
export const previewUniforms = {
  /** Repeats across the plane in u and v; v accounts for the repeat's aspect. */
  repeats: uniform(new Vector2(8, 8)),
  lightDir: uniform(new Vector3(0.4, 0.5, 0.75)),
  color: uniform(new Color(0.8, 0.3, 0.15)),
  shininess: uniform(64),
  roughness: uniform(0.35),
  thickness: uniform(2),
  specular: uniform(1),
};

export interface PreviewTextures {
  weave: DataTexture;
  relief: DataTexture;
  momentA: DataTexture;
  momentB: DataTexture;
}

function halfTexture(levels: { size: number; data: Float32Array }[]): DataTexture {
  const toHalf = (f: Float32Array) => {
    const out = new Uint16Array(f.length);
    for (let i = 0; i < f.length; i++) out[i] = DataUtils.toHalfFloat(f[i]!);
    return out;
  };
  const base = levels[0]!;
  const t = new DataTexture(toHalf(base.data), base.size, base.size, RGBAFormat, HalfFloatType);
  t.mipmaps = levels.map((l) => ({ data: toHalf(l.data), width: l.size, height: l.size }));
  t.wrapS = t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** Moment mips as two half-float textures with an explicit mip chain. */
export function makeMomentTextures(levels: MomentLevel[]): { momentA: DataTexture; momentB: DataTexture } {
  return {
    momentA: halfTexture(levels.map((l) => ({ size: l.size, data: l.a }))),
    momentB: halfTexture(levels.map((l) => ({ size: l.size, data: l.b }))),
  };
}

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
    case 'lit (SGGX, filtered)':
      color = sggxLit(textures, st);
      break;
    default: {
      // Plane faces +z, fabric u along x and v along y, so fabric space = world space here.
      const L = normalize(previewUniforms.lightDir);
      const V = normalize(cameraPosition.sub(positionWorld));
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

/** w^T S w for a symmetric matrix given as its six entries. */
function quad(xx: Node<'float'>, yy: Node<'float'>, zz: Node<'float'>, xy: Node<'float'>, xz: Node<'float'>, yz: Node<'float'>, w: Node<'vec3'>): Node<'float'> {
  return xx
    .mul(w.x.mul(w.x))
    .add(yy.mul(w.y.mul(w.y)))
    .add(zz.mul(w.z.mul(w.z)))
    .add(xy.mul(w.x.mul(w.y)).add(xz.mul(w.x.mul(w.z))).add(yz.mul(w.y.mul(w.z))).mul(2));
}

/**
 * Default-tier specular: the SGGX matrix S = I - (1 - alpha^2) M from the mipmapped tangent
 * moment M, so the filtered highlight stays stable at one sample per pixel. Jin et al. specular
 * with a Lambert diffuse; the full fabric material (internal lobes, noise, transmission) is step 3.
 */
function sggxLit(textures: PreviewTextures, st: Node<'vec2'>): Node<'vec3'> {
  const a = texture(textures.momentA, st);
  const b = texture(textures.momentB, st);
  const r = texture(textures.relief, st);
  const coverage = a.w;
  const k = float(1).sub(previewUniforms.roughness.mul(previewUniforms.roughness));
  // S = I - k M; Mzz follows from trace(M) = 1.
  const mxx = a.x, myy = a.y, mxy = a.z, mxz = b.x, myz = b.y;
  const mzz = float(1).sub(mxx).sub(myy);
  const sxx = float(1).sub(k.mul(mxx));
  const syy = float(1).sub(k.mul(myy));
  const szz = float(1).sub(k.mul(mzz));
  const sxy = k.mul(mxy).negate();
  const sxz = k.mul(mxz).negate();
  const syz = k.mul(myz).negate();

  const det = sxx.mul(syy.mul(szz).sub(syz.mul(syz))).sub(sxy.mul(sxy.mul(szz).sub(syz.mul(sxz)))).add(sxz.mul(sxy.mul(syz).sub(syy.mul(sxz))));
  const ixx = syy.mul(szz).sub(syz.mul(syz)).div(det);
  const iyy = sxx.mul(szz).sub(sxz.mul(sxz)).div(det);
  const izz = sxx.mul(syy).sub(sxy.mul(sxy)).div(det);
  const ixy = sxz.mul(syz).sub(sxy.mul(szz)).div(det);
  const ixz = sxy.mul(syz).sub(sxz.mul(syy)).div(det);
  const iyz = sxy.mul(sxz).sub(sxx.mul(syz)).div(det);

  const L = normalize(previewUniforms.lightDir);
  const V = normalize(cameraPosition.sub(positionWorld));
  const H = normalize(L.add(V));
  const ci = max(L.z, 1e-4);
  const co = max(V.z, 1e-4);
  const q = quad(ixx, iyy, izz, ixy, ixz, iyz, H);
  const D = float(1).div(sqrt(max(det, 1e-12)).mul(q.mul(q)).mul(Math.PI));
  const li = sqrt(max(quad(sxx, syy, szz, sxy, sxz, syz, L), 0)).div(ci);
  const lo = sqrt(max(quad(sxx, syy, szz, sxy, sxz, syz, V), 0)).div(co);
  const lsum = li.add(lo);
  const G = float(1).sub(exp(previewUniforms.thickness.negate().mul(lsum))).div(lsum);
  // Radiance = f * cos(theta_i); the cos cancels one of the 4 ci co.
  const spec = D.mul(G).div(co.mul(4)).mul(previewUniforms.specular).mul(coverage);
  const diffuse = previewUniforms.color.mul(max(L.z, 0).mul(0.75).add(0.25)).mul(r.y);
  const backdrop = vec3(0.05);
  return mix(backdrop, diffuse.add(spec), coverage);
}
