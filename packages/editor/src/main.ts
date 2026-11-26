import GUI from 'lil-gui';
import { Mesh, PerspectiveCamera, PlaneGeometry, Scene, SRGBColorSpace, WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  bakeKnitMaps,
  bakeMomentMips,
  bakeTwoLobeMips,
  bakeDiffractionLut,
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
import { createFpsCounter } from './fps.ts';
import { makeDiffractionTexture, makeMomentTextures, makeTwoLobeTextures, makeNoiseTexture, makePreviewMaterial, makeTwoLayerTexture, makeTextures, previewUniforms, views, type PreviewTextures, type View } from './preview.ts';

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
  await renderer.init();
  document.getElementById('app')!.appendChild(renderer.domElement);

  const scene = new Scene();
  const camera = new PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.01, 100);
  camera.position.set(0, -0.6, 2.2);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const plane = new Mesh(new PlaneGeometry(2, 2));
  scene.add(plane);

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
    view: 'lit (SGGX, filtered)' as View,
    roughness: 0.35,
    thickness: 2,
    specular: 1,
    glint: 0.5,
    noiseCorrelation: defaultWaveNoiseParams.correlation,
    noiseHighOrder: defaultWaveNoiseParams.highOrderCorrelation,
    noiseSeed: defaultWaveNoiseParams.seed,
    repeats: 8,
    lightAzimuth: 40,
    lightElevation: 50,
    backlight: 1,
    threadSpacing: 300,
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
  let noiseTiles: WaveNoiseTiles;
  let twoLayerLut: TwoLayerLut;

  function bakeNoise(): ReturnType<typeof makeNoiseTexture> {
    const t0 = performance.now();
    noiseTiles = bakeWaveNoise({ correlation: state.noiseCorrelation, highOrderCorrelation: state.noiseHighOrder, seed: state.noiseSeed });
    noiseMs = performance.now() - t0;
    return makeNoiseTexture(noiseTiles);
  }
  let noise = bakeNoise();
  const diffractionLut = bakeDiffractionLut();
  const diffraction = makeDiffractionTexture(diffractionLut);
  let twoLayer: ReturnType<typeof makeTwoLayerTexture> | undefined;
  let gapFraction = 0;

  /** Approximate yarn diameter from ply count and diameter (circle packing of the plies). */
  function yarnDiameterUm(yarn: YarnData): number {
    return yarn.plyDiameterUm * ([1, 2, 2.15, 2.41][yarn.plies - 1] ?? Math.sqrt(yarn.plies) * 1.25);
  }

  /** Two-layer table depends on colour, gap fraction and yarn density; cheap, rebaked on change. */
  function rebakeTwoLayer(): void {
    const linear = previewUniforms.color.value;
    setTwoLayer(bakeTwoLayerLut({
      albedo: [linear.r, linear.g, linear.b],
      tau: state.yarnTau,
      backFraction: state.backFraction,
      gapFraction,
      gapDepth: state.fabric === 'knit' ? state.yarnRadius * 2 : state.flatness * 0.5,
    }));
  }

  function setTwoLayer(lut: TwoLayerLut): void {
    twoLayerLut = lut;
    twoLayer?.dispose();
    twoLayer = makeTwoLayerTexture(lut);
    if (textures) {
      textures.twoLayer = twoLayer;
      rebuildMaterial();
    }
  }

  function updateGaps(): void {
    const s = state.threadSpacing;
    const knit = state.fabric === 'knit';
    const ax = knit ? 0.2 * s : (Math.max(1 - state.warpWidth, 0.02) * s) / 2;
    const ay = knit ? 0.2 * s : (Math.max(1 - state.weftWidth, 0.02) * s) / 2;
    previewUniforms.gapHalfWidth.value.set(ax, ay);
    // The coherent beam spans about one thread spacing.
    previewUniforms.beamRatio.value.set(s / 2 / ax, s / 2 / ay);
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
    plane.material = makePreviewMaterial(textures, state.view);
    if (!Array.isArray(old)) old.dispose();
  }

  function bake(): void {
    const options = { size: state.size, aoStrength: state.aoStrength };
    let maps: WeaveMaps;
    let name: string;
    const t0 = performance.now();
    try {
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
    if (textures) for (const t of [textures.weave, textures.relief, textures.momentA, textures.momentB, textures.lobeA, textures.lobeB, textures.lobeC]) t.dispose();
    let gaps = 0;
    for (let i = 2; i < maps.relief.length; i += 4) gaps += maps.relief[i]!;
    gapFraction = gaps / 255 / (maps.size * maps.size);
    updateLight();
    if (lut) setTwoLayer(lut);
    else rebakeTwoLayer();
    textures = {
      ...makeTextures(maps),
      ...makeMomentTextures(mips),
      ...makeTwoLobeTextures(lobes),
      noise,
      noiseInstances: defaultWaveNoiseParams.instances,
      twoLayer: twoLayer!,
      diffraction,
      diffractionLut,
    };
    aspect = maps.aspect;
    updateLight();
    rebuildMaterial();
    statusBase = statusText;
    showStatus();
  }

  async function exportFabric(): Promise<void> {
    if (!baked) return;
    const bytes = await writeFabric({
      name: baked.name,
      settings: { ...state, yarnsPerRepeat },
      maps: baked.maps,
      moments: baked.moments,
      twoLobes: baked.twoLobes,
      twoLayer: twoLayerLut,
      noise: noiseTiles,
    });
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
    previewUniforms.roughness.value = state.roughness;
    previewUniforms.thickness.value = state.thickness;
    previewUniforms.specular.value = state.specular;
    previewUniforms.glint.value = state.glint;
    previewUniforms.backlight.value = state.backlight;
    updateGaps();
    previewUniforms.yarnsPerRepeat.value = yarnsPerRepeat;
    // The plane is square: a repeat `aspect` times wider than tall needs that many more repeats along v.
    previewUniforms.repeats.value.set(state.repeats, state.repeats * aspect);
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
  viewFolder
    .addColor(state, 'color')
    .name('Color')
    .onChange(() => {
      updateLight();
      rebakeTwoLayer();
    });
  viewFolder.add(state, 'roughness', 0.05, 1, 0.01).name('Fiber roughness (SGGX)').onChange(updateLight);
  viewFolder.add(state, 'thickness', 0.1, 10, 0.1).name('Optical thickness (SGGX)').onChange(updateLight);
  viewFolder.add(state, 'specular', 0, 3, 0.01).name('Specular strength (SGGX)').onChange(updateLight);
  viewFolder.add(state, 'glint', 0, 1, 0.01).name('Glint (wave noise)').onChange(updateLight);
  viewFolder.add(state, 'shininess', 4, 512, 1).name('Sharpness (unfiltered)').onChange(updateLight);
  viewFolder.add(state, 'lightAzimuth', -180, 180, 1).name('Light azimuth').onChange(updateLight);
  viewFolder.add(state, 'lightElevation', -90, 90, 1).name('Light elevation (< 0: behind)').onChange(updateLight);

  const sheerFolder = gui.addFolder('Opacity and back light');
  sheerFolder.add(state, 'backlight', 0, 10, 0.1).name('Back light intensity').onChange(updateLight);
  sheerFolder.add(state, 'threadSpacing', 50, 2000, 10).name('Thread spacing (µm)').onChange(updateLight);
  sheerFolder.add(state, 'yarnTau', 0.1, 6, 0.05).name('Yarn density').onChange(rebakeTwoLayer);
  sheerFolder.add(state, 'backFraction', 0.05, 0.95, 0.01).name('Back-scatter fraction').onChange(rebakeTwoLayer);

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
    renderer.render(scene, camera);
    fps.tick();
  });
}

start().catch((e: unknown) => {
  status.textContent = `Failed to start: ${(e as Error).message}`;
  console.error(e);
});
