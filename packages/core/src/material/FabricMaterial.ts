import { Color, DoubleSide, EnvironmentNode, LightingModel, MeshStandardNodeMaterial, Vector2 } from 'three/webgpu';
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
  isolate,
  length,
  log,
  materialEnvIntensity,
  max,
  mix,
  normalize,
  normalView,
  normalWorld,
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
import { defaultFiberParams, fitFiberAlbedo } from '../lut/yarnScattering.ts';
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

/** Directional albedo of the sheen layer (rational fit, see lut/sheen.ts). */
function sheenAlbedo(mu: F, roughness: F): F {
  const x = clamp(mu, 1e-3, 1);
  const y = clamp(roughness, 0.01, 1);
  const s = y.mul(y.mul(1.58491).add(0.0206607)).div(y.mul(y.add(1.32227)).add(0.0379424));
  const m = y.mul(y.mul(y.mul(float(1.7932).sub(y.mul(y).mul(0.95943))).sub(1.14885)).sub(0.193854)).div(y.add(0.046391));
  const o = y.mul(y.mul(y.mul(0.119681).sub(0.0207818)).add(0.000654023)).div(y.mul(y.sub(1.92021)).add(1.26264));
  const g = x.sub(m).div(s);
  return max(exp(g.mul(g).mul(-0.5)).div(s.mul(Math.sqrt(2 * Math.PI))).add(o), 0);
}

/** Normalized sheen lobe over L for view V (fabric frame, +z up), cosine included (lut/sheen.ts). */
function sheenLobe(L: V3, V: V3, roughness: F): F {
  const x = clamp(V.z, 1e-3, 1);
  const y = clamp(roughness, 0.01, 1);
  const X = normalize(vec3(V.x, V.y, 0).add(vec3(1e-5, 0, 0)));
  const wx = dot(L.xy, X.xy);
  const wy = L.y.mul(X.x).sub(L.x.mul(X.y));
  const aInv = x.mul(2.58126).add(y.mul(0.813703)).mul(y).div(x.mul(x).mul(0.310327).add(x.mul(y).mul(2.60994)).add(1));
  // Zero at normal incidence, where the tangent frame X is arbitrary.
  const bInv = sqrt(float(1).sub(x)).mul(y.sub(1)).mul(y.mul(y).mul(y)).div(x.mul(1.71228).sub(x.mul(y).mul(1.71506)).add(y.mul(y).mul(1.34174)).add(0.0000254053));
  const ox = aInv.mul(wx).add(bInv.mul(L.z));
  const oy = aInv.mul(wy);
  const len2 = ox.mul(ox).add(oy.mul(oy)).add(L.z.mul(L.z));
  const k = aInv.div(len2);
  return max(L.z, 0).mul(1 / Math.PI).mul(k.mul(k));
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
    /**
     * Linear RGB weight of light that crosses a clear fiber and leaves toward the viewer (TT),
     * which tints satin and silk highlights. Set from the fiber colour fitted to the cloth.
     */
    fiberTint: uniform(new Color(0, 0, 0)),
    /** Fiber index of refraction; sets the Fresnel reflectance of the specular lobe. */
    ior: uniform(1.55),
    /** 0 = opaque, 1 = see through the weave gaps. */
    sheerness: uniform(1),
    yarnsPerRepeat: uniform(4),
    gapHalfWidth: uniform(new Vector2(50, 50)),
    beamRatio: uniform(new Vector2(2, 2)),
    /** Concentration of the forward glow around a light seen through the yarn (1 / variance). */
    forwardKappa: uniform(4),
    /**
     * Share of the diffuse and transmitted light shaded with the yarn normal rather than the
     * macro normal, 0..1 (1 - w in Yang et al.'s diffuse term). Shows the round yarns up close;
     * the normal's mips fade it into flat shading at a distance.
     */
    yarnNormal: uniform(0.75),
    /**
     * Angular radius of the lights (radians), which bounds the diffraction peak seen through the
     * gaps. Three's lights are points, so this stands in for the lamp's size: 0.03 is a lamp of
     * 12 cm at 2 m. The sun is 0.0047, which makes a far brighter, sharper cross.
     */
    lightSize: uniform(0.03),
    /** Fly-away fiber cover, 0..1 (sheen layer, Zeltner et al. 2022 as used by Zhu et al. 2024). */
    sheen: uniform(0.3),
    /** Width of the sheen lobe, 0.01..1. */
    sheenRoughness: uniform(0.5),
    /** Linear RGB colour of the loose fibers; set from the fiber colour fitted to the cloth. */
    sheenColor: uniform(new Color(0.8, 0.8, 0.8)),
    /**
     * Strength of shadows the yarns cast on each other under low light, 0..1 (from the baked
     * horizon map; the visibility term of Zhu et al.'s model, here per light from 1 fetch).
     */
    selfShadow: uniform(1),
  };

  /**
   * Environment light arriving on the back of the cloth, set while the shader is built
   * (see FabricEnvironmentNode); absent when the scene has no environment.
   */
  backIrradiance: V3 | undefined;

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
      if (s.forwardVariance) this.fabric.forwardKappa.value = Math.min(1 / s.forwardVariance, 1000);
    }
    if (asset.yarn) this.fabric.ior.value = asset.yarn.ior;
    if (s) {
      // TT share heading back toward the viewer: entry and exit (1 - F0) squared, the fiber's
      // clarity and colour, and the backward share of the TT azimuthal lobe (Zhu et al.).
      const f0 = ((this.fabric.ior.value - 1) / (this.fabric.ior.value + 1)) ** 2;
      const fiber = fitFiberAlbedo(s.albedo, { ...defaultFiberParams, ior: this.fabric.ior.value });
      const w = (1 - f0) ** 2 * defaultFiberParams.clarity * (1 - defaultFiberParams.ttForward);
      this.fabric.fiberTint.value.setRGB(fiber[0] * w, fiber[1] * w, fiber[2] * w);
      // A loose fiber is seen mostly on its own, so it is paler than the cloth (whose colour comes
      // from many fibers deep); a few fibers overlap, so take the geometric mean of the two.
      const [r, g, b] = s.albedo;
      this.fabric.sheenColor.value.setRGB(Math.sqrt(r * fiber[0]), Math.sqrt(g * fiber[1]), Math.sqrt(b * fiber[2]));
      if (s.sheen) {
        this.fabric.sheen.value = s.sheen.amount;
        this.fabric.sheenRoughness.value = s.sheen.roughness;
      }
    }
    // Only sheer fabrics need blending.
    this.transparent = (s?.gapFraction ?? 0) > 0.02;

    this.nodes = this.buildNodes();
    this.colorNode = this.fabric.color;
    this.opacityNode = this.nodes.opacity;
    // Roughness only picks the environment's prefiltered mip. Fiber lobes are much broader than
    // a GGX lobe of the same roughness (flake normals spread around every fiber), so blur more.
    this.roughnessNode = clamp(this.fabric.roughness.add(0.45), 0, 1);
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

    // Yarn shading normal from the baked map; its mips average it toward the macro normal.
    const yarnN = texture(t.normal, st).xyz.mul(2).sub(1);
    const bent = yarnN.div(max(length(yarnN), 1e-3));
    // Noise instance per ply and short yarn segment, in a frame bent by the yarn cross-section.
    const nb = normalize(cross(bent, yarnTangent));
    const nn = cross(yarnTangent, nb);
    const cell = floor(st);
    const seed = vec3(relief.w.mul(255).round().add(cell.x.mul(97)), floor(weave.w.mul(SEGMENTS)).add(cell.y.mul(57)), floor(weave.z.mul(PLIES)).add(1));
    const layer = floor(hash3(seed).mul(t.noiseInstances));
    const noiseOffset = vec2(hash3(seed.add(3.1)), hash3(seed.add(7.7)));
    const yarnsPerPixel = length(fwidth(st)).mul(f.yarnsPerRepeat);
    const glintContrast = f.glint.div(max(yarnsPerPixel, 1));

    // Open weave gaps as seen from the viewer: they close at oblique angles, as the yarns'
    // height hides them (the two-layer table's gap channel, relative to normal incidence).
    const muV = clamp(toFabric(positionViewDirection).z.abs(), 0, 1);
    const closing = texture(t.twoLayer, vec2(muV, 0.25)).w.div(max(texture(t.twoLayer, vec2(1, 0.25)).w, 1e-4));
    const gapView = float(1).sub(coverage).mul(clamp(closing, 0, 1));
    // Blending shows the background through sheer gaps (alpha = opacity); the colour must then be
    // the yarn radiance scaled by the visible yarn share over alpha, or it is darkened twice.
    // Open gaps keep a tiny opacity so light added there (diffraction) is not discarded by the
    // blend; dividing every term by opacity makes colour x alpha come out exact.
    const opacity = max(float(1).sub(gapView.mul(f.sheerness)), 0.02);
    const weight = float(1).sub(gapView).div(opacity);
    // Open share of the pattern at normal incidence (two-layer table), for the light side.
    const gapNormal = max(texture(t.twoLayer, vec2(1, 0.25)).w, 1e-4);

    // Sheen layer on top of everything: it reflects sheenReflect toward the viewer and passes
    // the rest on (Zhu et al. 2024, eq. 4). Fuzz sits on the yarns, so open gaps have none.
    const sheenReflect = clamp(f.sheen, 0, 1).mul(sheenAlbedo(muV, f.sheenRoughness));
    const sheenThrough = float(1).sub(sheenReflect.mul(float(1).sub(gapView)));

    const horizon = texture(t.horizon, st);

    return { st, toFabric, coverage, opacity, weight, gapView, gapNormal, lobeInputs, occlusion: shade.y, yarnTangent, bent, nb, nn, layer, noiseOffset, glintContrast, sheenReflect, sheenThrough, horizon };
  }

  /**
   * Light reaching the yarn surface past the neighbouring yarns: the light's elevation against
   * the horizon in its direction, blended between the u and v horizons by azimuth. The mipmapped
   * horizon averages over the yarns a pixel covers, so distant cloth darkens only at low light.
   */
  selfShadowing(L: V3): F {
    const h = this.nodes.horizon;
    const xx = L.x.mul(L.x);
    const wx = xx.div(xx.add(L.y.mul(L.y)).add(1e-6));
    const hu = select(L.x.greaterThanEqual(0), h.x, h.y);
    const hv = select(L.y.greaterThanEqual(0), h.z, h.w);
    const horizon = mix(hv, hu, wx);
    const visible = smoothstep(horizon.sub(0.12), horizon.add(0.04), L.z);
    return mix(float(1), visible, this.fabric.selfShadow);
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
  specular(L: V3, V: V3, H: V3): V3 {
    let sum: F = float(0);
    for (const { m, w } of this.nodes.lobeInputs) sum = sum.add(this.sggxLobe(m, L, V, H).mul(w));
    // Lobe weights sum to the texel's yarn coverage; renormalize, then weight like the diffuse.
    sum = sum.div(max(this.nodes.coverage, 1e-3)).mul(this.nodes.weight);
    const tint = this.fabric.fiberTint as unknown as V3;
    return tint.add(this.fresnel(clamp(dot(V, H), 0, 1))).mul(sum).mul(this.fabric.specular);
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
      return density.div(density.mul(f.lightSize.mul(2)).add(1));
    };
    const channel = (lambda: number) =>
      profile(deviation.x, f.gapHalfWidth.x, rowX, lambda).mul(profile(deviation.y, f.gapHalfWidth.y, rowY, lambda));
    return vec3(channel(WAVELENGTHS[0]), channel(WAVELENGTHS[1]), channel(WAVELENGTHS[2]));
  }

  /** three's environment lighting, plus the environment behind the cloth for transmission. */
  override setupEnvironment(builder: NodeBuilder): EnvironmentNode | null {
    const env = super.setupEnvironment(builder) as EnvironmentNode | null;
    return env ? new FabricEnvironmentNode(env.envNode as Node, this) : null;
  }

  override setupLightingModel(): PhysicalLightingModel {
    return new FabricLightingModel(this) as unknown as PhysicalLightingModel;
  }

  override dispose(): void {
    disposeFabricTextures(this.textures);
    super.dispose();
  }
}

/**
 * three's EnvironmentNode gathers environment light over the hemisphere the surface faces. Cloth
 * also passes on light from the hemisphere behind it, so this adds the irradiance on the back
 * side, read from the same prefiltered environment the same way.
 */
class FabricEnvironmentNode extends EnvironmentNode {
  constructor(
    envNode: Node,
    private readonly material: FabricMaterial,
  ) {
    super(envNode);
  }

  override setup(builder: NodeBuilder): undefined {
    super.setup(builder);
    // After setup the environment is the PMREM node that three resolved for it.
    const env = ((this as unknown as { _pmremNode: Node | null })._pmremNode ?? this.envNode) as unknown as {
      context(values: object): V3;
    };
    const back = env.context({ getUV: () => normalWorld.negate(), getTextureLevel: () => float(1) });
    this.material.backIrradiance = isolate(back.mul(Math.PI).mul(materialEnvIntensity)) as unknown as V3;
    return undefined;
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
    // Cosine on the yarn surface (Yang et al. 2026, eq. 2): blend the macro normal's with the
    // yarn normal's. Light from behind enters the back of the yarn, the front normal mirrored.
    const yarnN = vec3(n.bent.x, n.bent.y, select(front.greaterThan(0), n.bent.z, n.bent.z.negate()));
    const muShade = mix(mu, max(dot(L, yarnN), 0), f.yarnNormal);
    const twoLayerGain = texture(m.textures.twoLayer, vec2(mu, 0.25));
    const forward = texture(m.textures.twoLayer, vec2(mu, 0.75));
    const [glintSpecular, glintDiffuse] = m.glints(H, V);
    const color = lightColor as V3;
    const albedo = f.color as unknown as V3;
    const out = reflectedLight as unknown as Record<'directDiffuse' | 'directSpecular', V3>;

    // Front: Lambert-like body reflection scaled by the inter-layer bounces, and fiber specular.
    const shadow = m.selfShadowing(L);
    const diffuse = albedo.mul(twoLayerGain.rgb).mul(n.occlusion).mul(muShade.mul(1 / Math.PI)).mul(front).mul(shadow);
    const specular = m.specular(L, V, H).mul(front).mul(shadow);
    // Back: transmission through the yarn, split into light that kept close to straight
    // through (a von Mises-Fisher lobe around -L, Zhu et al.'s forward yarn lobe) and light
    // scattered into a diffuse glow; plus diffraction through the open gaps.
    const kappa = f.forwardKappa;
    const lobe = exp(kappa.mul(dot(V, L.negate()).sub(1))).mul(kappa.div(float(1).sub(exp(kappa.mul(-2))).mul(2 * Math.PI)));
    const spread = mix(float(1 / Math.PI), lobe, forward.w);
    const transmitted = forward.rgb.mul(muShade).mul(spread).mul(back);
    // Gap light is seen through pixels that are mostly transparent; undo the blend's alpha.
    // Diffracted light leaves through the open gaps under this pixel (the far-field average
    // when they are unresolved), as far as they stay open toward the light too.
    const lightOpen = clamp(twoLayerGain.w.div(n.gapNormal), 0, 1);
    const diffracted = m.diffraction(V.add(L)).mul(n.gapView).mul(lightOpen).mul(f.sheerness).mul(back).div(n.opacity);

    // Sheen: fuzz above the yarns reflects its share into a wide lobe; the cloth below gets the rest.
    const sheen = (f.sheenColor as unknown as V3).mul(n.sheenReflect).mul(sheenLobe(L, V, f.sheenRoughness)).mul(front).mul(n.weight);
    out.directDiffuse.addAssign(color.mul(diffuse.add(transmitted).mul(glintDiffuse).mul(n.weight).mul(n.sheenThrough)));
    out.directSpecular.addAssign(color.mul(glintSpecular.mul(specular).add(diffracted).mul(n.sheenThrough).add(sheen)));
  }

  override indirect(builder: NodeBuilder): void {
    // `irradiance` holds ambient and hemisphere lights; the environment map's diffuse light
    // arrives separately as `iblIrradiance` (three's PhysicalLightingModel reads both).
    const { irradiance, iblIrradiance, radiance, reflectedLight } = builder.context as unknown as {
      irradiance: V3;
      iblIrradiance: V3;
      radiance: V3;
      reflectedLight: Record<'indirectDiffuse' | 'indirectSpecular', V3>;
    };
    const m = this.material;
    const n = m.nodes;
    const f = m.fabric;
    // Hemispherical average gain: sample the two-layer table at mu = 2/3 (the cosine-weighted mean).
    const gain = texture(m.textures.twoLayer, vec2(2 / 3, 0.25)).rgb;
    const front = irradiance.add(iblIrradiance);
    reflectedLight.indirectDiffuse.addAssign(front.mul(f.color as unknown as V3).mul(gain).mul(n.occlusion).mul(n.weight).mul(n.sheenThrough).mul(1 / Math.PI));
    // The sheen lobe is wide, so under environment light it reflects its albedo of the irradiance.
    reflectedLight.indirectSpecular.addAssign(front.mul(f.sheenColor as unknown as V3).mul(n.sheenReflect).mul(n.weight).mul(1 / Math.PI));
    // Environment light from behind, passed on through the yarn: the forward albedo at the
    // cosine-weighted mean angle, spread diffusely (the narrow share of a broad source is
    // diffuse anyway). Light that crosses the open gaps unscattered is the blended background.
    if (m.backIrradiance) {
      const forward = texture(m.textures.twoLayer, vec2(2 / 3, 0.75)).rgb;
      reflectedLight.indirectDiffuse.addAssign(m.backIrradiance.mul(forward).mul(n.weight).mul(n.sheenThrough).mul(1 / Math.PI));
    }
    // Environment specular: prefiltered radiance times the lobe's directional albedo (Fresnel and
    // slab shadowing included), and the yarn occlusion. See bakeSpecularAlbedo.
    const V = n.toFabric(positionViewDirection);
    const albedoLut = texture(m.textures.specularAlbedo, vec2(clamp(V.z, 0, 1), f.roughness));
    const albedo = (f.fiberTint as unknown as V3).mul(albedoLut.y).add(albedoLut.x);
    reflectedLight.indirectSpecular.addAssign(radiance.mul(albedo).mul(f.specular).mul(n.occlusion).mul(n.weight).mul(n.sheenThrough));
  }
}
