import { Color, DoubleSide, LightingModel, MeshStandardNodeMaterial, Vector2 } from 'three/webgpu';
import type { LightingModelDirectInput, Node, NodeBuilder, PhysicalLightingModel } from 'three/webgpu';
import {
  abs,
  asin,
  atan,
  clamp,
  cross,
  dFdx,
  dFdy,
  dot,
  exp,
  float,
  floor,
  fract,
  fwidth,
  int,
  length,
  log,
  max,
  mix,
  normalize,
  normalView,
  positionView,
  positionViewDirection,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import type { FabricAsset } from '../asset/fabricFile.ts';
import { WAVE_NOISE_MAX } from '../noise/waveNoise.ts';
import { createFabricTextures, disposeFabricTextures, type FabricTextures } from './textures.ts';

export type FabricTier = 'default' | 'quality';

export interface FabricMaterialOptions {
  /**
   * `default`: one filtered SGGX lobe per pixel (2 fetches), the 60 fps tier.
   * `quality`: warp and weft keep separate lobes (3 fetches), the 30 fps tier.
   */
  tier?: FabricTier;
  /** Pattern repeats across the mesh UVs, in u and v. Default 8. */
  repeats?: number | Vector2;
}

/** Wavelengths in micrometres for the R, G, B channels of the diffraction term. */
const WAVELENGTHS = [0.65, 0.55, 0.45] as const;
/** Angular radius of a light in sin(theta); a real lamp has size, which bounds the diffraction peak. */
const SOURCE_RADIUS = 0.004;
/** Plies across a yarn and noise segments along one yarn period, for noise instances. */
const PLIES = 3;
const SEGMENTS = 6;

type F = Node<'float'>;
type V3 = Node<'vec3'>;
type V2 = Node<'vec2'>;

function octDecode(e: V2): V3 {
  const f = e.mul(2).sub(1);
  const z = float(1).sub(abs(f.x)).sub(abs(f.y));
  const t = max(z.negate(), 0);
  const x = f.x.add(select(f.x.greaterThanEqual(0), t.negate(), t));
  const y = f.y.add(select(f.y.greaterThanEqual(0), t.negate(), t));
  return normalize(vec3(x, y, z));
}

function hash3(p: V3): F {
  return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
}

/** w^T S w for a symmetric 3x3 given as six entries. */
function quad(xx: F, yy: F, zz: F, xy: F, xz: F, yz: F, w: V3): F {
  return xx
    .mul(w.x.mul(w.x))
    .add(yy.mul(w.y.mul(w.y)))
    .add(zz.mul(w.z.mul(w.z)))
    .add(xy.mul(w.x.mul(w.y)).add(xz.mul(w.x.mul(w.z))).add(yz.mul(w.y.mul(w.z))).mul(2));
}

/**
 * Three.js material for woven and knitted cloth, built from a baked {@link FabricAsset}.
 *
 * Works with ordinary three.js lights (directional, point, spot) and `scene.environment`.
 * Front-lit: filtered SGGX fiber specular (Yang et al.), diffuse with the two-layer gain
 * (Yu et al.), wave-optics glints. Lit from behind: diffuse transmission and weave-gap
 * diffraction. No mesh tangents are needed; the fabric frame comes from the UVs.
 */
export class FabricMaterial extends MeshStandardNodeMaterial {
  readonly isFabricMaterial = true;
  readonly asset: FabricAsset;
  readonly textures: FabricTextures;
  readonly tier: FabricTier;

  /** Live parameters; change `.value` at any time. */
  readonly fabric = {
    repeats: uniform(new Vector2(8, 8)),
    /** Linear RGB yarn albedo. */
    color: uniform(new Color(0.8, 0.8, 0.8)),
    /** Fiber roughness of the SGGX lobe. */
    roughness: uniform(0.35),
    /** Optical thickness of the fiber layer in the SGGX G term. */
    thickness: uniform(2),
    specular: uniform(1),
    /** Wave-optics glint strength, 0..1. */
    glint: uniform(0.5),
    /** Fiber index of refraction; sets the Fresnel reflectance of the specular lobe. */
    ior: uniform(1.55),
    /** 0 = opaque, 1 = see through the weave gaps. */
    sheerness: uniform(1),
    yarnsPerRepeat: uniform(4),
    gapHalfWidth: uniform(new Vector2(50, 50)),
    beamRatio: uniform(new Vector2(2, 2)),
  };

  /** Shared per-pixel nodes the lighting model reads. */
  readonly nodes: ReturnType<FabricMaterial['buildNodes']>;

  constructor(asset: FabricAsset, options: FabricMaterialOptions = {}) {
    super();
    this.asset = asset;
    this.tier = options.tier === 'quality' && asset.twoLobes ? 'quality' : 'default';
    this.textures = createFabricTextures(asset);
    this.side = DoubleSide;
    this.metalness = 0;

    const s = asset.shading;
    const repeats = options.repeats ?? 8;
    const r = typeof repeats === 'number' ? new Vector2(repeats, repeats * asset.maps.aspect) : repeats;
    this.fabric.repeats.value.copy(r);
    if (s) {
      this.fabric.color.value.setRGB(...s.albedo);
      this.fabric.yarnsPerRepeat.value = s.yarnsPerRepeat;
      this.fabric.gapHalfWidth.value.set(...s.gapHalfWidthUm);
      this.fabric.beamRatio.value.set(...s.beamRatio);
    }
    if (asset.yarn) this.fabric.ior.value = asset.yarn.ior;
    // Only sheer fabrics need blending.
    this.transparent = (s?.gapFraction ?? 0) > 0.02;

    this.nodes = this.buildNodes();
    this.colorNode = this.fabric.color;
    this.opacityNode = mix(float(1), this.nodes.coverage, this.fabric.sheerness);
    // Roughness only steers the environment's prefiltered radiance; fiber highlights are broad.
    this.roughnessNode = float(0.55);
  }

  private buildNodes() {
    const t = this.textures;
    const f = this.fabric;
    const st = uv().mul(f.repeats);

    // Fabric frame from screen-space derivatives of position and UV (no mesh tangents needed).
    const N = normalize(normalView);
    const dp1 = dFdx(positionView);
    const dp2 = dFdy(positionView);
    const duv1 = dFdx(st);
    const duv2 = dFdy(st);
    const dp2perp = cross(dp2, N);
    const dp1perp = cross(N, dp1);
    const T = normalize(dp2perp.mul(duv1.x).add(dp1perp.mul(duv2.x)));
    const B = normalize(dp2perp.mul(duv1.y).add(dp1perp.mul(duv2.y)));
    const toFabric = (w: V3): V3 => vec3(dot(w, T), dot(w, B), dot(w, N));

    const weave = texture(t.weave, st);
    const relief = texture(t.relief, st);
    const shade = texture(t.shade, st);
    const yarnTangent = octDecode(weave.xy);

    let coverage: F;
    let lobeInputs: { m: [F, F, F, F, F]; w: F }[];
    if (this.tier === 'quality' && t.lobes) {
      const a = texture(t.lobes.a, st);
      const b = texture(t.lobes.b, st);
      const c = texture(t.lobes.c, st);
      coverage = a.w.add(c.w);
      lobeInputs = [
        { m: [a.x, a.y, a.z, b.x, b.y], w: a.w },
        { m: [c.x, c.y, c.z, b.z, b.w], w: c.w },
      ];
    } else {
      const a = texture(t.momentA, st);
      const b = texture(t.momentB, st);
      coverage = a.w;
      lobeInputs = [{ m: [a.x, a.y, a.z, b.x, b.y], w: a.w }];
    }

    // Noise instance per ply and short yarn segment; frame bent by the round cross-section.
    const across = weave.z.mul(2).sub(1);
    const side = normalize(vec3(yarnTangent.y.negate(), yarnTangent.x, 0));
    const bent = normalize(vec3(0, 0, 1).mul(sqrt(max(float(1).sub(across.mul(across)), 0.05))).add(side.mul(across)));
    const nb = normalize(cross(bent, yarnTangent));
    const nn = cross(yarnTangent, nb);
    const cell = floor(st);
    const seed = vec3(relief.w.mul(255).round().add(cell.x.mul(97)), floor(weave.w.mul(SEGMENTS)).add(cell.y.mul(57)), floor(weave.z.mul(PLIES)).add(1));
    const layer = floor(hash3(seed).mul(t.noiseInstances));
    const noiseOffset = vec2(hash3(seed.add(3.1)), hash3(seed.add(7.7)));
    const yarnsPerPixel = length(fwidth(st)).mul(f.yarnsPerRepeat);
    const glintContrast = f.glint.div(max(yarnsPerPixel, 1));

    return { st, toFabric, coverage, lobeInputs, occlusion: shade.y, yarnTangent, bent, nb, nn, layer, noiseOffset, glintContrast };
  }

  /** Speckle multipliers (mean 1) for the specular and diffuse parts; see bakeWaveNoise. */
  glints(H: V3, V: V3): [V3, V3] {
    const n = this.nodes;
    const t = this.textures;
    const angles = (w: V3): V2 => {
      const theta = asin(clamp(dot(w, n.yarnTangent), -1, 1));
      const phi = atan(dot(w, n.nb), dot(w, n.nn));
      return vec2(phi.div(2 * Math.PI).add(0.5), theta.div(Math.PI).add(0.5)).add(n.noiseOffset);
    };
    const decode = (v: V3): V3 => v.mul(v).mul(WAVE_NOISE_MAX);
    // Memory effect: the reflection speckle is read where the half vector meets normal incidence.
    const mirrored = H.mul(dot(H, n.nn).mul(2)).sub(n.nn);
    const reflection = decode(texture(t.noise, angles(mirrored)).depth(int(n.layer)).rgb);
    const highOrder = decode(texture(t.noise, angles(V)).depth(int(n.layer.add(t.noiseInstances))).rgb);
    return [reflection.sub(1).mul(n.glintContrast).add(1), highOrder.sub(1).mul(n.glintContrast.mul(0.25)).add(1)];
  }

  /**
   * Coverage-weighted sum of SGGX fiber lobes, as radiance per unit irradiance (cos included).
   * The SGGX layer reflects almost everything it intercepts, so the fiber surface's Fresnel
   * reflectance (about 5% for polymers and silk) scales it; the rest enters the fibers.
   */
  specular(L: V3, V: V3, H: V3): F {
    let sum: F = float(0);
    for (const { m, w } of this.nodes.lobeInputs) sum = sum.add(this.sggxLobe(m, L, V, H).mul(w));
    return sum.mul(this.fresnel(clamp(dot(V, H), 0, 1))).mul(this.fabric.specular);
  }

  /** Schlick Fresnel for the fiber's index of refraction. */
  fresnel(cosTheta: F): F {
    const ior = this.fabric.ior;
    const f0 = ior.sub(1).div(ior.add(1)).pow(2);
    return f0.add(float(1).sub(f0).mul(float(1).sub(cosTheta).pow(5)));
  }

  private sggxLobe([mxx, myy, mxy, mxz, myz]: [F, F, F, F, F], L: V3, V: V3, H: V3): F {
    const f = this.fabric;
    const k = float(1).sub(f.roughness.mul(f.roughness));
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
    const ci = max(L.z, 1e-4);
    const co = max(V.z, 1e-4);
    const q = quad(ixx, iyy, izz, ixy, ixz, iyz, H);
    const D = float(1).div(sqrt(max(det, 1e-12)).mul(q.mul(q)).mul(Math.PI));
    const li = sqrt(max(quad(sxx, syy, szz, sxy, sxz, syz, L), 0)).div(ci);
    const lo = sqrt(max(quad(sxx, syy, szz, sxy, sxz, syz, V), 0)).div(co);
    const lsum = li.add(lo);
    const G = float(1).sub(exp(f.thickness.negate().mul(lsum))).div(lsum);
    return D.mul(G).div(co.mul(4));
  }

  /**
   * Light diffracted through the weave gaps toward the viewer, per unit irradiance and open
   * area: separable across-warp times across-weft profiles at three wavelengths.
   */
  diffraction(deviation: V3): V3 {
    const t = this.textures;
    const f = this.fabric;
    const { uMax, rMin, rMax } = t.diffractionLut;
    const rowOf = (ratio: F) => log(clamp(ratio, rMin, rMax).div(rMin)).div(Math.log(rMax / rMin));
    const rowX = rowOf(f.beamRatio.x);
    const rowY = rowOf(f.beamRatio.y);
    const profile = (s: F, halfWidth: F, row: F, lambda: number): F => {
      const scale = halfWidth.mul((2 * Math.PI) / lambda);
      const u = abs(s).mul(scale);
      const fade = float(1).sub(smoothstep(uMax * 0.6, uMax, u));
      const density = texture(t.diffraction, vec2(u.div(uMax), row)).x.mul(scale).mul(fade);
      return density.div(density.mul(2 * SOURCE_RADIUS).add(1));
    };
    const channel = (lambda: number) =>
      profile(deviation.x, f.gapHalfWidth.x, rowX, lambda).mul(profile(deviation.y, f.gapHalfWidth.y, rowY, lambda));
    return vec3(channel(WAVELENGTHS[0]), channel(WAVELENGTHS[1]), channel(WAVELENGTHS[2]));
  }

  override setupLightingModel(): PhysicalLightingModel {
    return new FabricLightingModel(this) as unknown as PhysicalLightingModel;
  }

  override dispose(): void {
    disposeFabricTextures(this.textures);
    super.dispose();
  }
}

/** Per-light shading for {@link FabricMaterial}. */
class FabricLightingModel extends LightingModel {
  constructor(private readonly material: FabricMaterial) {
    super();
  }

  override direct({ lightDirection, lightColor, reflectedLight }: LightingModelDirectInput): void {
    const m = this.material;
    const n = m.nodes;
    const f = m.fabric;
    const L = n.toFabric(normalize(lightDirection as V3));
    const V = n.toFabric(positionViewDirection);
    const H = normalize(L.add(V));
    const front = step(0, L.z);
    const back = float(1).sub(front);
    const mu = abs(L.z);
    const twoLayerGain = texture(m.textures.twoLayer, vec2(mu, 0.25));
    const forward = texture(m.textures.twoLayer, vec2(mu, 0.75));
    const [glintSpecular, glintDiffuse] = m.glints(H, V);
    const color = lightColor as V3;
    const albedo = f.color as unknown as V3;
    const out = reflectedLight as unknown as Record<'directDiffuse' | 'directSpecular', V3>;

    // Front: Lambert-like body reflection scaled by the inter-layer bounces, and fiber specular.
    const diffuse = albedo.mul(twoLayerGain.rgb).mul(n.occlusion).mul(mu.mul(1 / Math.PI)).mul(front);
    const specular = m.specular(L, V, H).mul(front);
    // Back: diffuse transmission through the yarn, and diffraction through the open gaps.
    const transmitted = forward.rgb.mul(mu.mul(1 / Math.PI)).mul(back);
    const diffracted = m.diffraction(V.add(L)).mul(twoLayerGain.w).mul(back);

    out.directDiffuse.addAssign(color.mul(diffuse.add(transmitted).mul(glintDiffuse).mul(n.coverage)));
    out.directSpecular.addAssign(color.mul(glintSpecular.mul(specular).add(diffracted)));
  }

  override indirect(builder: NodeBuilder): void {
    const { irradiance, radiance, reflectedLight } = builder.context as unknown as {
      irradiance: V3;
      radiance: V3;
      reflectedLight: Record<'indirectDiffuse' | 'indirectSpecular', V3>;
    };
    const m = this.material;
    const n = m.nodes;
    const f = m.fabric;
    // Hemispherical average gain: sample the two-layer table at mu = 2/3 (the cosine-weighted mean).
    const gain = texture(m.textures.twoLayer, vec2(2 / 3, 0.25)).rgb;
    reflectedLight.indirectDiffuse.addAssign(irradiance.mul(f.color as unknown as V3).mul(gain).mul(n.occlusion).mul(n.coverage).mul(1 / Math.PI));
    const V = n.toFabric(positionViewDirection);
    reflectedLight.indirectSpecular.addAssign(radiance.mul(m.fresnel(clamp(V.z, 0, 1))).mul(f.specular).mul(n.coverage));
  }
}
