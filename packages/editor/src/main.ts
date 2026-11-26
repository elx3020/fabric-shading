import GUI from 'lil-gui';
import { Mesh, PerspectiveCamera, PlaneGeometry, Scene, SRGBColorSpace, WebGPURenderer, type DataTexture } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  bakeWeaveMaps,
  defaultWeaveParams,
  plainWeave,
  satinWeave,
  twillWeave,
  wovenPresets,
  type WeaveParams,
  type WeavePattern,
} from '@fabric-shading/core';
import { makePreviewMaterial, makeTextures, previewUniforms, views, type View } from './preview.ts';

const status = document.getElementById('status')!;

async function start(): Promise<void> {
  if (!('gpu' in navigator) || !(await navigator.gpu.requestAdapter())) {
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
    weave: 'satin' as 'plain' | 'twill' | 'satin',
    twillOver: 2,
    twillUnder: 2,
    satinEnds: 5,
    satinStep: 2,
    warpFaced: true,
    size: 256,
    aoStrength: 0.6,
    view: 'lit' as View,
    repeats: 8,
    lightAzimuth: 40,
    lightElevation: 50,
    color: '#d9521f',
    shininess: 64,
    ...defaultWeaveParams,
  };

  let textures: { weave: DataTexture; relief: DataTexture } | undefined;

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

  function rebuildMaterial(): void {
    if (!textures) return;
    const old = plane.material;
    plane.material = makePreviewMaterial(textures, state.view);
    if (!Array.isArray(old)) old.dispose();
  }

  function bake(): void {
    let pattern: WeavePattern;
    try {
      pattern = currentPattern();
    } catch (e) {
      status.textContent = (e as Error).message;
      return;
    }
    const params: WeaveParams = {
      warpWidth: state.warpWidth,
      weftWidth: state.weftWidth,
      crimp: state.crimp,
      flatness: state.flatness,
      irregularity: state.irregularity,
      seed: state.seed,
    };
    const t0 = performance.now();
    const maps = bakeWeaveMaps(pattern, params, { size: state.size, aoStrength: state.aoStrength });
    const ms = performance.now() - t0;
    textures?.weave.dispose();
    textures?.relief.dispose();
    textures = makeTextures(maps);
    rebuildMaterial();
    status.textContent = `${pattern.name} · ${maps.size}² texels · baked in ${ms.toFixed(1)} ms`;
  }

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
    previewUniforms.repeats.value = state.repeats;
  }

  function applyPreset(id: string): void {
    const preset = wovenPresets.find((p) => p.id === id);
    if (!preset) return;
    const pattern = preset.pattern();
    Object.assign(state, defaultWeaveParams, preset.params);
    if (pattern.name.startsWith('satin')) {
      state.weave = 'satin';
      state.satinEnds = pattern.rows;
      const step = pattern.warpUp[1]!.findIndex((up) => !up);
      state.satinStep = step;
      state.warpFaced = true;
    } else if (pattern.name.startsWith('twill')) {
      state.weave = 'twill';
      state.twillOver = pattern.warpUp[0]!.filter(Boolean).length;
      state.twillUnder = pattern.cols - state.twillOver;
    } else {
      state.weave = 'plain';
    }
    const [r, g, b] = preset.color;
    state.color = `#${[r, g, b].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
    updateLight();
    scheduleBake();
  }

  const gui = new GUI({ title: 'Fabric editor' });
  gui
    .add(state, 'preset', Object.fromEntries(wovenPresets.map((p) => [p.label, p.id])))
    .name('Preset')
    .onChange(applyPreset);

  const weaveFolder = gui.addFolder('Weave');
  weaveFolder.add(state, 'weave', ['plain', 'twill', 'satin']).name('Type').onChange(scheduleBake);
  weaveFolder.add(state, 'twillOver', 1, 6, 1).name('Twill over').onChange(scheduleBake);
  weaveFolder.add(state, 'twillUnder', 1, 6, 1).name('Twill under').onChange(scheduleBake);
  weaveFolder.add(state, 'satinEnds', 5, 12, 1).name('Satin ends').onChange(scheduleBake);
  weaveFolder.add(state, 'satinStep', 2, 10, 1).name('Satin step').onChange(scheduleBake);
  weaveFolder.add(state, 'warpFaced').name('Warp-faced').onChange(scheduleBake);

  const yarnFolder = gui.addFolder('Yarn');
  yarnFolder.add(state, 'warpWidth', 0.2, 1, 0.01).name('Warp width').onChange(scheduleBake);
  yarnFolder.add(state, 'weftWidth', 0.2, 1, 0.01).name('Weft width').onChange(scheduleBake);
  yarnFolder.add(state, 'crimp', 0, 1, 0.01).name('Crimp').onChange(scheduleBake);
  yarnFolder.add(state, 'flatness', 0.2, 1, 0.01).name('Roundness').onChange(scheduleBake);
  yarnFolder.add(state, 'irregularity', 0, 1, 0.01).name('Irregularity').onChange(scheduleBake);
  yarnFolder.add(state, 'seed', 1, 999, 1).name('Seed').onChange(scheduleBake);

  const bakeFolder = gui.addFolder('Bake');
  bakeFolder.add(state, 'size', [64, 128, 256, 512, 1024]).name('Texels per repeat').onChange(scheduleBake);
  bakeFolder.add(state, 'aoStrength', 0, 1, 0.01).name('Occlusion').onChange(scheduleBake);

  const viewFolder = gui.addFolder('Preview');
  viewFolder.add(state, 'view', views).name('Show').onChange(rebuildMaterial);
  viewFolder.add(state, 'repeats', 1, 64, 1).name('Repeats on plane').onChange(updateLight);
  viewFolder.addColor(state, 'color').name('Color').onChange(updateLight);
  viewFolder.add(state, 'shininess', 4, 512, 1).name('Highlight sharpness').onChange(updateLight);
  viewFolder.add(state, 'lightAzimuth', -180, 180, 1).name('Light azimuth').onChange(updateLight);
  viewFolder.add(state, 'lightElevation', 5, 90, 1).name('Light elevation').onChange(updateLight);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  applyPreset(state.preset);
  bake();

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
}

start().catch((e: unknown) => {
  status.textContent = `Failed to start: ${(e as Error).message}`;
  console.error(e);
});
