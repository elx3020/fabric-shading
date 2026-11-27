import GUI from 'lil-gui';
import { ACESFilmicToneMapping, Color, DirectionalLight, Mesh, PerspectiveCamera, PlaneGeometry, Scene, SRGBColorSpace, WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  bakeKnitMaps,
  bakeMomentMips,
  bakeTwoLobeMips,
  bakeTwoLayerLut,
  bakeWaveNoise,
  readFabric,
  writeFabric,
  defaultWaveNoiseParams,
  bakeWeaveMaps,
  defaultKnitParams,
  defaultWeaveParams,
  garterKnit,
  jerseyKnit,
  knitPresets,
  plainWeave,
  ribKnit,
  seedKnit,
  satinWeave,
  twillWeave,
  wovenPresets,
  fabricShading,
  fiberParams,
  type FabricAsset,
  type FabricSpec,
  type KnitPattern,
  type MomentLevel,
  type TwoLobeLevel,
  type TwoLayerLut,
  type WaveNoiseTiles,
  type YarnData,
  type WeaveMaps,
  type WeaveParams,
  type WeavePattern,
} from '@fabric-shading/core';
import { FabricMaterial } from '@fabric-shading/core/material';
import { createEnvironment } from './environment.ts';
import { createFpsCounter } from './fps.ts';
import { makeNoiseTexture, makePreviewMaterial, makeTextures, materialViews, previewUniforms, views, type PreviewTextures, type View } from './preview.ts';

const status = document.getElementById('status')!;

/** Returns null when WebGPU is usable, otherwise a short reason for the unsupported page. */
async function webgpuProblem(): Promise<string | null> {
  if (!window.isSecureContext) return 'The page is not a secure context (needs https or localhost).';
  if (!('gpu' in navigator)) return 'navigator.gpu is missing: this browser does not expose WebGPU here.';
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return 'navigator.gpu exists but requestAdapter() returned null: the GPU or driver is blocked, or WebGPU is disabled in the browser.';
  } catch (error) {
    return `requestAdapter() threw: ${String(error)}`;
  }
  return null;
}

async function start(): Promise<void> {
  const problem = await webgpuProblem();
  if (problem) {
    if (!window.isSecureContext) document.getElementById('insecure')!.hidden = false;
    document.getElementById('reason')!.textContent = `Reason: ${problem} (${navigator.userAgent})`;
    document.getElementById('unsupported')!.style.display = 'block';
    status.style.display = 'none';
    return;
  }

  const renderer = new WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  await renderer.init();
  document.getElementById('app')!.appendChild(renderer.domElement);

  const scene = new Scene();
  const camera = new PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.01, 100);
  camera.position.set(0, -0.6, 2.2);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const plane = new Mesh(new PlaneGeometry(2, 2));
  scene.add(plane);

  // The lit views use the real FabricMaterial under ordinary three.js lights: a key light
  // (azimuth, elevation), a back light straight behind the cloth facing the camera (for
  // transmission and the diffraction cross), and image-based light from a sky .hdr (or the
  // user's own).
  const env = createEnvironment(renderer, scene);
  await env.loadDefault();
  const keyLight = new DirectionalLight(0xffffff, 2.5);
  const backLight = new DirectionalLight(0xffffff, 0);
  scene.add(keyLight, backLight);

  const state = {
    preset: wovenPresets[0]!.id,
    fabric: 'woven' as 'woven' | 'knit',
    knit: 'jersey' as 'jersey' | 'reverse jersey' | 'rib' | 'garter' | 'seed',
    ribKnit: 2,
    ribPurl: 2,
    stitchAspect: defaultKnitParams.stitchAspect,
    yarnRadius: defaultKnitParams.yarnRadius,
    relief: defaultKnitParams.relief,
    weave: 'satin' as 'plain' | 'twill' | 'satin',
    twillOver: 2,
    twillUnder: 2,
    satinEnds: 5,
    satinStep: 2,
    warpFaced: true,
    size: 256,
    aoStrength: 0.6,
    view: materialViews[0] as View,
    roughness: 0.35,
    thickness: 2,
    specular: 1,
    glint: 0.5,
    yarnNormal: 0.75,
    sheen: 0.3,
    sheenRoughness: 0.5,
    selfShadow: 1,
    parallax: 1,
    noiseCorrelation: defaultWaveNoiseParams.correlation,
    noiseHighOrder: defaultWaveNoiseParams.highOrderCorrelation,
    noiseSeed: defaultWaveNoiseParams.seed,
    repeats: 8,
    lightAzimuth: 40,
    lightElevation: 50,
    keyLight: 2.5,
    lightSize: 0.03,
    environment: 0.4,
    environmentRotation: 0,
    hdrBackground: false,
    backlight: 0,
    threadSpacing: 300,
    fiberModel: true,
    yarnTau: 1.5,
    backFraction: 0.35,
    color: '#d9521f',
    shininess: 64,
    ...defaultWeaveParams,
  };

  let textures: PreviewTextures | undefined;
  let aspect = 1;
  let yarnsPerRepeat = 4;
  let noiseMs = 0;
  let statusBase = '';

  /** What the last bake (or import) produced; this is what Export writes. */
  let baked: { name: string; maps: WeaveMaps; moments: MomentLevel[]; twoLobes: TwoLobeLevel[] } | undefined;
  /** Pattern and parameters of the current maps, and the selected preset's measured yarn. */
  let bakedSpec: FabricSpec | undefined;
  let presetYarn: YarnData | undefined;
  let fabricMat: FabricMaterial | undefined;
  let noiseTiles: WaveNoiseTiles;
  let twoLayerLut: TwoLayerLut;

  function bakeNoise(): ReturnType<typeof makeNoiseTexture> {
    const t0 = performance.now();
    noiseTiles = bakeWaveNoise({ correlation: state.noiseCorrelation, highOrderCorrelation: state.noiseHighOrder, seed: state.noiseSeed });
    noiseMs = performance.now() - t0;
    return makeNoiseTexture(noiseTiles);
  }
  let noise = bakeNoise();
  let gapFraction = 0;

  function srgbColor(): [number, number, number] {
    const c = new Color(state.color);
    return [c.r, c.g, c.b].map((v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)) as [number, number, number];
  }

  /** The editor's current pattern as a FabricSpec, with colour and the preset's yarn data. */
  function specFromState(): FabricSpec {
    const common = { color: srgbColor(), sheen: { amount: state.sheen, roughness: state.sheenRoughness }, ...(presetYarn ? { yarn: presetYarn } : {}) };
    if (state.fabric === 'knit') {
      return {
        kind: 'knit',
        pattern: currentKnit(),
        params: { stitchAspect: state.stitchAspect, yarnRadius: state.yarnRadius, relief: state.relief, irregularity: state.irregularity, seed: state.seed },
        ...common,
      };
    }
    return {
      kind: 'woven',
      pattern: currentPattern(),
      params: { warpWidth: state.warpWidth, weftWidth: state.weftWidth, crimp: state.crimp, flatness: state.flatness, irregularity: state.irregularity, seed: state.seed },
      ...common,
    };
  }

  /** Everything FabricMaterial needs, as Export writes it (including the shading and yarn blocks). */
  function currentAsset(): FabricAsset | undefined {
    if (!baked || !bakedSpec) return undefined;
    const spec = { ...bakedSpec, color: srgbColor(), sheen: { amount: state.sheen, roughness: state.sheenRoughness }, ...(presetYarn ? { yarn: presetYarn } : {}) };
    return {
      name: baked.name,
      settings: { ...state, yarnsPerRepeat },
      maps: baked.maps,
      moments: baked.moments,
      twoLobes: baked.twoLobes,
      twoLayer: twoLayerLut,
      noise: noiseTiles,
      shading: fabricShading(spec, baked.maps, state.threadSpacing),
      ...(presetYarn ? { yarn: presetYarn } : {}),
    };
  }

  /** Approximate yarn diameter from ply count and diameter (circle packing of the plies). */
  function yarnDiameterUm(yarn: YarnData): number {
    return yarn.plyDiameterUm * ([1, 2, 2.15, 2.41][yarn.plies - 1] ?? Math.sqrt(yarn.plies) * 1.25);
  }

  /**
   * Two-layer table: from the preset's fiber data (Zhu et al. yarn scattering) when known and
   * enabled, otherwise from the yarn density and back-scatter sliders. Cheap; rebaked on change.
   */
  function rebakeTwoLayer(): void {
    const linear = new Color(state.color);
    const useYarn = state.fiberModel && presetYarn !== undefined;
    densityControl.enable(!useYarn);
    backFractionControl.enable(!useYarn);
    setTwoLayer(
      bakeTwoLayerLut({
        albedo: [linear.r, linear.g, linear.b],
        tau: state.yarnTau,
        backFraction: state.backFraction,
        gapFraction,
        gapDepth: state.fabric === 'knit' ? state.yarnRadius * 2 : state.flatness * 0.5,
        ...(useYarn ? { yarn: { data: presetYarn!, fiber: fiberParams(specFromState()) } } : {}),
      }),
    );
  }

  function setTwoLayer(lut: TwoLayerLut): void {
    twoLayerLut = lut;
    rebuildMaterial();
  }

  /** Gap widths and beam ratio from the thread spacing (see fabricShading), live on the material. */
  function updateGaps(): void {
    if (!fabricMat) return;
    const s = state.threadSpacing;
    const knit = state.fabric === 'knit';
    const ax = knit ? 0.2 * s : (Math.max(1 - state.warpWidth, 0.02) * s) / 2;
    const ay = knit ? 0.2 * s : (Math.max(1 - state.weftWidth, 0.02) * s) / 2;
    fabricMat.fabric.gapHalfWidth.value.set(ax, ay);
    // The coherent beam spans about one thread spacing.
    fabricMat.fabric.beamRatio.value.set(s / 2 / ax, s / 2 / ay);
  }

  function showStatus(): void {
    status.textContent = noiseMs > 0 ? `${statusBase} · noise ${noiseMs.toFixed(0)} ms` : statusBase;
  }

  function rebakeNoise(): void {
    noise.dispose();
    noise = bakeNoise();
    if (textures) textures.noise = noise;
    rebuildMaterial();
    showStatus();
  }

  function currentPattern(): WeavePattern {
    switch (state.weave) {
      case 'plain':
        return plainWeave();
      case 'twill':
        return twillWeave(state.twillOver, state.twillUnder);
      case 'satin':
        return satinWeave(state.satinEnds, state.satinStep, state.warpFaced);
    }
  }

  function currentKnit(): KnitPattern {
    switch (state.knit) {
      case 'jersey':
        return jerseyKnit(true);
      case 'reverse jersey':
        return jerseyKnit(false);
      case 'rib':
        return ribKnit(state.ribKnit, state.ribPurl);
      case 'garter':
        return garterKnit();
      case 'seed':
        return seedKnit();
    }
  }

  function rebuildMaterial(): void {
    if (!textures) return;
    const old = plane.material;
    const tierIndex = (materialViews as readonly string[]).indexOf(state.view);
    const asset = tierIndex >= 0 ? currentAsset() : undefined;
    if (asset) {
      fabricMat = new FabricMaterial(asset, { tier: tierIndex === 1 ? 'quality' : 'default', repeats: state.repeats });
      plane.material = fabricMat;
    } else {
      fabricMat = undefined;
      plane.material = makePreviewMaterial(textures, state.view);
    }
    updateLight();
    if (!Array.isArray(old)) old.dispose();
  }

  function bake(): void {
    const options = { size: state.size, aoStrength: state.aoStrength };
    let maps: WeaveMaps;
    let name: string;
    const t0 = performance.now();
    try {
      bakedSpec = specFromState();
      if (state.fabric === 'knit') {
        const pattern = currentKnit();
        name = pattern.name;
        yarnsPerRepeat = pattern.cols;
        maps = bakeKnitMaps(
          pattern,
          { stitchAspect: state.stitchAspect, yarnRadius: state.yarnRadius, relief: state.relief, irregularity: state.irregularity, seed: state.seed },
          options,
        );
      } else {
        const pattern = currentPattern();
        name = pattern.name;
        yarnsPerRepeat = pattern.cols;
        const params: WeaveParams = {
          warpWidth: state.warpWidth,
          weftWidth: state.weftWidth,
          crimp: state.crimp,
          flatness: state.flatness,
          irregularity: state.irregularity,
          seed: state.seed,
        };
        maps = bakeWeaveMaps(pattern, params, options);
      }
    } catch (e) {
      status.textContent = (e as Error).message;
      return;
    }
    const ms = performance.now() - t0;
    const mips = bakeMomentMips(maps);
    const lobes = bakeTwoLobeMips(maps);
    const ms2 = performance.now() - t0 - ms;
    install(name, maps, mips, lobes, `${name} · ${maps.size}² texels · maps ${ms.toFixed(0)} ms · specular mips ${ms2.toFixed(0)} ms`);
  }

  /** Uploads baked maps; uses `lut` as the two-layer table if given, otherwise rebakes it. */
  function install(name: string, maps: WeaveMaps, mips: MomentLevel[], lobes: TwoLobeLevel[], statusText: string, lut?: TwoLayerLut): void {
    baked = { name, maps, moments: mips, twoLobes: lobes };
    if (textures) for (const t of [textures.weave, textures.relief, textures.normal, textures.horizon]) t.dispose();
    let gaps = 0;
    for (let i = 2; i < maps.relief.length; i += 4) gaps += maps.relief[i]!;
    gapFraction = gaps / 255 / (maps.size * maps.size);
    updateLight();
    if (lut) setTwoLayer(lut);
    else rebakeTwoLayer();
    textures = { ...makeTextures(maps), noise, noiseInstances: defaultWaveNoiseParams.instances };
    aspect = maps.aspect;
    updateLight();
    rebuildMaterial();
    statusBase = statusText;
    showStatus();
  }

  async function exportFabric(): Promise<void> {
    const asset = currentAsset();
    if (!baked || !asset) return;
    const bytes = await writeFabric(asset);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
    link.download = `${baked.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.fabric`;
    link.click();
    URL.revokeObjectURL(link.href);
    status.textContent = `${statusBase} · exported ${(bytes.byteLength / 1024).toFixed(0)} KB`;
  }

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.fabric';
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const asset = await readFabric(new Uint8Array(await file.arrayBuffer()));
      // Restore known editor settings only; files from other versions may carry extra keys.
      for (const [key, value] of Object.entries(asset.settings)) {
        if (key in state && typeof value === typeof (state as Record<string, unknown>)[key]) (state as Record<string, unknown>)[key] = value;
      }
      if (typeof asset.settings.yarnsPerRepeat === 'number') yarnsPerRepeat = asset.settings.yarnsPerRepeat;
      cancelAnimationFrame(pending);
      noise.dispose();
      noiseTiles = asset.noise;
      noise = makeNoiseTexture(noiseTiles);
      noiseMs = 0;
      if (!(views as readonly string[]).includes(state.view)) state.view = materialViews[0];
      presetYarn = asset.yarn;
      if (asset.shading) state.threadSpacing = Math.round(asset.shading.threadSpacingUm);
      bakedSpec = specFromState();
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      showFolders();
      install(asset.name, asset.maps, asset.moments, asset.twoLobes ?? bakeTwoLobeMips(asset.maps), `${asset.name} · ${asset.maps.size}² texels · imported from ${file.name}`, asset.twoLayer);
    } catch (e) {
      status.textContent = `Import failed: ${(e as Error).message}`;
    }
  });
  const fileActions = { export: () => void exportFabric(), import: () => fileInput.click() };

  let pending = 0;
  const scheduleBake = () => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(bake);
  };

  function updateLight(): void {
    const az = (state.lightAzimuth * Math.PI) / 180;
    const el = (state.lightElevation * Math.PI) / 180;
    previewUniforms.lightDir.value.set(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el));
    previewUniforms.color.value.set(state.color);
    previewUniforms.shininess.value = state.shininess;
    // The plane is square: a repeat `aspect` times wider than tall needs that many more repeats along v.
    previewUniforms.repeats.value.set(state.repeats, state.repeats * aspect);
    keyLight.position.set(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)).multiplyScalar(3);
    keyLight.intensity = state.keyLight;
    backLight.intensity = state.backlight;
    scene.environmentIntensity = state.environment;
    if (fabricMat) {
      const f = fabricMat.fabric;
      f.repeats.value.set(state.repeats, state.repeats * aspect);
      f.color.value.set(state.color);
      f.roughness.value = state.roughness;
      f.thickness.value = state.thickness;
      f.specular.value = state.specular;
      f.glint.value = state.glint;
      f.yarnNormal.value = state.yarnNormal;
      f.sheen.value = state.sheen;
      f.sheenRoughness.value = state.sheenRoughness;
      f.selfShadow.value = state.selfShadow;
      f.parallax.value = state.parallax;
      f.lightSize.value = state.lightSize;
      updateGaps();
    }
  }

  function setColor(rgb: [number, number, number]): void {
    state.color = `#${rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
  }

  function applyPreset(id: string): void {
    const knitPreset = knitPresets.find((p) => p.id === id);
    if (knitPreset) {
      const pattern = knitPreset.pattern();
      Object.assign(state, defaultKnitParams, knitPreset.params);
      state.fabric = 'knit';
      if (pattern.name.startsWith('rib')) {
        state.knit = 'rib';
        state.ribKnit = pattern.stitches[0]!.filter((s) => s === 'K').length;
        state.ribPurl = pattern.cols - state.ribKnit;
      } else {
        state.knit = pattern.name as typeof state.knit;
      }
      setColor(knitPreset.color);
      presetYarn = knitPreset.yarn;
      state.sheen = knitPreset.sheen.amount;
      state.sheenRoughness = knitPreset.sheen.roughness;
      state.threadSpacing = Math.round(yarnDiameterUm(knitPreset.yarn) / (2 * state.yarnRadius));
    } else {
      const preset = wovenPresets.find((p) => p.id === id);
      if (!preset) return;
      const pattern = preset.pattern();
      Object.assign(state, defaultWeaveParams, preset.params);
      state.fabric = 'woven';
      if (pattern.name.startsWith('satin')) {
        state.weave = 'satin';
        state.satinEnds = pattern.rows;
        state.satinStep = pattern.warpUp[1]!.findIndex((up) => !up);
        state.warpFaced = true;
      } else if (pattern.name.startsWith('twill')) {
        state.weave = 'twill';
        state.twillOver = pattern.warpUp[0]!.filter(Boolean).length;
        state.twillUnder = pattern.cols - state.twillOver;
      } else {
        state.weave = 'plain';
      }
      setColor(preset.color);
      presetYarn = preset.yarn;
      state.sheen = preset.sheen.amount;
      state.sheenRoughness = preset.sheen.roughness;
      state.threadSpacing = Math.round(yarnDiameterUm(preset.yarn) / Math.max(state.warpWidth, 0.2));
    }
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
    showFolders();
    updateLight();
    scheduleBake();
  }

  const gui = new GUI({ title: 'Fabric editor' });
  gui
    .add(state, 'preset', Object.fromEntries([...wovenPresets, ...knitPresets].map((p) => [p.label, p.id])))
    .name('Preset')
    .onChange(applyPreset);
  gui
    .add(state, 'fabric', ['woven', 'knit'])
    .name('Fabric')
    .onChange(() => {
      showFolders();
      scheduleBake();
    });

  const weaveFolder = gui.addFolder('Weave');
  weaveFolder.add(state, 'weave', ['plain', 'twill', 'satin']).name('Type').onChange(scheduleBake);
  weaveFolder.add(state, 'twillOver', 1, 6, 1).name('Twill over').onChange(scheduleBake);
  weaveFolder.add(state, 'twillUnder', 1, 6, 1).name('Twill under').onChange(scheduleBake);
  weaveFolder.add(state, 'satinEnds', 5, 12, 1).name('Satin ends').onChange(scheduleBake);
  weaveFolder.add(state, 'satinStep', 2, 10, 1).name('Satin step').onChange(scheduleBake);
  weaveFolder.add(state, 'warpFaced').name('Warp-faced').onChange(scheduleBake);

  const knitFolder = gui.addFolder('Knit');
  knitFolder.add(state, 'knit', ['jersey', 'reverse jersey', 'rib', 'garter', 'seed']).name('Stitch').onChange(scheduleBake);
  knitFolder.add(state, 'ribKnit', 1, 4, 1).name('Rib knit wales').onChange(scheduleBake);
  knitFolder.add(state, 'ribPurl', 1, 4, 1).name('Rib purl wales').onChange(scheduleBake);
  knitFolder.add(state, 'stitchAspect', 0.8, 1.8, 0.01).name('Stitch width').onChange(scheduleBake);
  knitFolder.add(state, 'yarnRadius', 0.12, 0.32, 0.005).name('Yarn thickness').onChange(scheduleBake);
  knitFolder.add(state, 'relief', 0, 1, 0.01).name('Relief').onChange(scheduleBake);

  const yarnFolder = gui.addFolder('Yarn');
  yarnFolder.add(state, 'warpWidth', 0.2, 1, 0.01).name('Warp width').onChange(scheduleBake);
  yarnFolder.add(state, 'weftWidth', 0.2, 1, 0.01).name('Weft width').onChange(scheduleBake);
  yarnFolder.add(state, 'crimp', 0, 1, 0.01).name('Crimp').onChange(scheduleBake);
  yarnFolder.add(state, 'flatness', 0.2, 1, 0.01).name('Roundness').onChange(scheduleBake);

  const variationFolder = gui.addFolder('Variation');
  variationFolder.add(state, 'irregularity', 0, 1, 0.01).name('Irregularity').onChange(scheduleBake);
  variationFolder.add(state, 'seed', 1, 999, 1).name('Seed').onChange(scheduleBake);

  function showFolders(): void {
    const knit = state.fabric === 'knit';
    knitFolder.show(knit);
    weaveFolder.show(!knit);
    yarnFolder.show(!knit);
  }

  const bakeFolder = gui.addFolder('Bake');
  bakeFolder.add(state, 'size', [64, 128, 256, 512, 1024]).name('Texels per repeat').onChange(scheduleBake);
  bakeFolder.add(state, 'aoStrength', 0, 1, 0.01).name('Occlusion').onChange(scheduleBake);

  const viewFolder = gui.addFolder('Preview');
  viewFolder.add(state, 'view', views).name('Show').onChange(rebuildMaterial);
  viewFolder.add(state, 'repeats', 1, 64, 1).name('Repeats on plane').onChange(updateLight);
  viewFolder.addColor(state, 'color').name('Color').onChange(updateLight).onFinishChange(rebakeTwoLayer);
  viewFolder.add(state, 'roughness', 0.05, 1, 0.01).name('Fiber roughness (SGGX)').onChange(updateLight);
  viewFolder.add(state, 'thickness', 0.1, 10, 0.1).name('Optical thickness (SGGX)').onChange(updateLight);
  viewFolder.add(state, 'specular', 0, 3, 0.01).name('Specular strength (SGGX)').onChange(updateLight);
  viewFolder.add(state, 'glint', 0, 1, 0.01).name('Glint (wave noise)').onChange(updateLight);
  viewFolder.add(state, 'yarnNormal', 0, 1, 0.01).name('Yarn normal shading').onChange(updateLight);
  viewFolder.add(state, 'sheen', 0, 1, 0.01).name('Sheen (fuzz)').onChange(updateLight);
  viewFolder.add(state, 'sheenRoughness', 0.01, 1, 0.01).name('Sheen roughness').onChange(updateLight);
  viewFolder.add(state, 'selfShadow', 0, 1, 0.01).name('Yarn self-shadowing').onChange(updateLight);
  viewFolder.add(state, 'parallax', 0, 1, 0.01).name('Parallax (quality tier)').onChange(updateLight);
  viewFolder.add(state, 'shininess', 4, 512, 1).name('Sharpness (unfiltered)').onChange(updateLight);
  viewFolder.add(state, 'lightAzimuth', -180, 180, 1).name('Light azimuth').onChange(updateLight);
  viewFolder.add(state, 'lightElevation', -90, 90, 1).name('Light elevation (< 0: behind)').onChange(updateLight);
  viewFolder.add(state, 'keyLight', 0, 8, 0.1).name('Light intensity').onChange(updateLight);
  viewFolder.add(state, 'lightSize', 0.005, 0.2, 0.001).name('Light size (rad)').onChange(updateLight);
  viewFolder.add(state, 'environment', 0, 2, 0.01).name('Environment light').onChange(updateLight);
  viewFolder.add({ hdr: () => env.pick((m) => (status.textContent = m)) }, 'hdr').name('Load environment .hdr…');
  viewFolder.add(state, 'environmentRotation', -180, 180, 1).name('Environment rotation').onChange((v: number) => env.setRotation(v));
  viewFolder.add(state, 'hdrBackground').name('Show .hdr as background').onChange((v: boolean) => env.setBackground(v));

  const sheerFolder = gui.addFolder('Opacity and back light');
  sheerFolder.add(state, 'backlight', 0, 10, 0.1).name('Back light (behind, facing you)').onChange(updateLight);
  sheerFolder.add(state, 'threadSpacing', 50, 2000, 10).name('Thread spacing (µm)').onChange(updateLight);
  sheerFolder.add(state, 'fiberModel').name('Yarn scattering from fiber data').onChange(rebakeTwoLayer);
  const densityControl = sheerFolder.add(state, 'yarnTau', 0.1, 6, 0.05).name('Yarn density').onChange(rebakeTwoLayer);
  const backFractionControl = sheerFolder.add(state, 'backFraction', 0.05, 0.95, 0.01).name('Back-scatter fraction').onChange(rebakeTwoLayer);
  sheerFolder
    .add(
      {
        backlit: () => {
          // Cloth held against a window: a broad, bright source behind, the room's own light
          // (the environment, left as it is) in front, and a weak key light.
          state.keyLight = 0.5;
          state.backlight = 2.5;
          state.lightSize = 0.1;
          gui.controllersRecursive().forEach((c) => c.updateDisplay());
          updateLight();
        },
      },
      'backlit',
    )
    .name('Back-lit setup (window behind)');

  const fileFolder = gui.addFolder('File');
  fileFolder.add(fileActions, 'export').name('Export .fabric');
  fileFolder.add(fileActions, 'import').name('Import .fabric');

  const noiseFolder = gui.addFolder('Wave noise');
  noiseFolder.add(state, 'noiseCorrelation', 0.75, 4, 0.05).name('Glint grain').onFinishChange(rebakeNoise);
  noiseFolder.add(state, 'noiseHighOrder', 1, 8, 0.1).name('Inner grain').onFinishChange(rebakeNoise);
  noiseFolder.add(state, 'noiseSeed', 1, 999, 1).name('Seed').onFinishChange(rebakeNoise);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  applyPreset(state.preset);

  const fps = createFpsCounter(document.getElementById('fps')!);
  renderer.setAnimationLoop(() => {
    controls.update();
    // Keep the back light directly behind the cloth, shining toward the camera.
    backLight.position.copy(camera.position).negate();
    renderer.render(scene, camera);
    fps.tick();
  });
}

start().catch((e: unknown) => {
  status.textContent = `Failed to start: ${(e as Error).message}`;
  console.error(e);
});
