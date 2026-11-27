import GUI from 'lil-gui';
import {
  ACESFilmicToneMapping,
  BufferAttribute,
  Color,
  DirectionalLight,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  WebGPURenderer,
} from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { fabricFromPreset, knitPresets, readFabric, wovenPresets, type FabricAsset } from '@fabric-shading/core';
import { FabricMaterial, type FabricTier } from '@fabric-shading/core/material';
import { createEnvironment } from './environment.ts';
import { createFpsCounter } from './fps.ts';

const status = document.getElementById('status')!;

async function webgpuProblem(): Promise<string | null> {
  if (!window.isSecureContext) return 'The page is not a secure context (needs https or localhost).';
  if (!('gpu' in navigator)) return 'navigator.gpu is missing.';
  try {
    if (!(await navigator.gpu.requestAdapter())) return 'requestAdapter() returned null: the GPU or driver is blocked, or WebGPU is disabled.';
  } catch (error) {
    return `requestAdapter() threw: ${String(error)}`;
  }
  return null;
}

/** A gently waving cloth: summed travelling waves, normals recomputed on the CPU (cheap at this size). */
class WavingCloth {
  readonly geometry = new PlaneGeometry(1.6, 1.6, 96, 96);
  private readonly rest: Float32Array;
  amplitude = 0.06;

  constructor() {
    this.rest = (this.geometry.attributes.position as BufferAttribute).array.slice() as Float32Array;
  }

  update(time: number): void {
    const pos = this.geometry.attributes.position as BufferAttribute;
    const p = pos.array as Float32Array;
    for (let i = 0; i < p.length; i += 3) {
      const x = this.rest[i]!;
      const y = this.rest[i + 1]!;
      p[i + 2] =
        this.amplitude *
        (Math.sin(x * 3.1 + time * 1.3) * 0.6 + Math.sin(y * 4.3 - time * 1.7 + x) * 0.4 + Math.sin((x + y) * 7 + time * 2.3) * 0.15);
    }
    pos.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }
}

async function start(): Promise<void> {
  const problem = await webgpuProblem();
  if (problem) {
    document.getElementById('reason')!.textContent = `Reason: ${problem} (${navigator.userAgent})`;
    document.getElementById('unsupported')!.style.display = 'block';
    status.style.display = 'none';
    return;
  }

  const renderer = new WebGPURenderer({ antialias: true, trackTimestamp: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  await renderer.init();
  document.getElementById('app')!.appendChild(renderer.domElement);

  const scene = new Scene();
  scene.background = new Color(0x15161a);
  // Image-based lighting from the bundled sky .hdr until the user loads another.
  const env = createEnvironment(renderer, scene);
  await env.loadDefault();
  scene.environmentIntensity = 0.5;

  const camera = new PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.01, 100);
  camera.position.set(0, -0.4, 2.4);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const light = new DirectionalLight(0xffffff, 2);
  scene.add(light, light.target);
  // A small bright marker so the light's position (and the diffraction it causes) is easy to find.
  const marker = new Mesh(new SphereGeometry(0.03, 16, 8), new MeshBasicNodeMaterial({ color: 0xffffff }));
  scene.add(marker);

  const cloth = new WavingCloth();
  const mesh = new Mesh(cloth.geometry);
  scene.add(mesh);

  const state = {
    preset: 'silk-organza',
    tier: 'default' as FabricTier,
    repeats: 24,
    roughness: 0.35,
    specular: 1,
    glint: 0.5,
    sheerness: 1,
    environment: 0.5,
    environmentRotation: 0,
    hdrBackground: false,
    animate: true,
    waves: 0.06,
    lightBehind: false,
    lightIntensity: 2,
    lightAzimuth: 35,
    lightElevation: 45,
  };

  let asset: FabricAsset;
  let material: FabricMaterial | undefined;
  let bakeMs = 0;
  let source = '';

  function buildMaterial(): void {
    const old = material;
    material = new FabricMaterial(asset, { tier: state.tier, repeats: state.repeats });
    applyParams();
    mesh.material = material;
    old?.dispose();
    status.textContent = `${source} · ${material.tier} tier · ${bakeMs > 0 ? `baked in ${bakeMs.toFixed(0)} ms` : 'loaded from file'}`;
  }

  function applyParams(): void {
    if (!material) return;
    const f = material.fabric;
    f.repeats.value.set(state.repeats, state.repeats * asset.maps.aspect);
    f.roughness.value = state.roughness;
    f.specular.value = state.specular;
    f.glint.value = state.glint;
    f.sheerness.value = state.sheerness;
    scene.environmentIntensity = state.environment;
    cloth.amplitude = state.waves;
    placeLight();
  }

  function placeLight(): void {
    const az = (state.lightAzimuth * Math.PI) / 180;
    const el = (state.lightElevation * Math.PI) / 180;
    const side = state.lightBehind ? -1 : 1;
    light.position.set(Math.cos(el) * Math.cos(az) * 3, Math.cos(el) * Math.sin(az) * 3, side * Math.sin(el) * 3);
    light.intensity = state.lightIntensity;
    marker.position.copy(light.position).multiplyScalar(0.8);
  }

  function loadPreset(id: string): void {
    const t0 = performance.now();
    asset = fabricFromPreset(id);
    bakeMs = performance.now() - t0;
    source = asset.name;
    buildMaterial();
  }

  loadPreset(state.preset);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.fabric';
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      asset = await readFabric(new Uint8Array(await file.arrayBuffer()));
      bakeMs = 0;
      source = `${asset.name} (${file.name})`;
      if (!asset.shading) source += ' · no shading block, using defaults';
      buildMaterial();
    } catch (e) {
      status.textContent = `Could not load ${file.name}: ${(e as Error).message}`;
    }
  });

  const gui = new GUI({ title: 'Fabric plane' });
  gui
    .add(state, 'preset', Object.fromEntries([...wovenPresets, ...knitPresets].map((p) => [p.label, p.id])))
    .name('Preset')
    .onChange(loadPreset);
  gui.add({ load: () => fileInput.click() }, 'load').name('Load .fabric…');
  gui.add(state, 'tier', ['default', 'quality']).name('Tier').onChange(buildMaterial);
  const look = gui.addFolder('Look');
  look.add(state, 'repeats', 2, 250, 1).name('Repeats on cloth').onChange(applyParams);
  look.add(state, 'roughness', 0.05, 1, 0.01).name('Fiber roughness').onChange(applyParams);
  look.add(state, 'specular', 0, 3, 0.01).name('Specular').onChange(applyParams);
  look.add(state, 'glint', 0, 1, 0.01).name('Glint').onChange(applyParams);
  look.add(state, 'sheerness', 0, 1, 0.01).name('See-through gaps').onChange(applyParams);
  const lighting = gui.addFolder('Lighting');
  lighting.add(state, 'environment', 0, 2, 0.01).name('Environment').onChange(applyParams);
  lighting.add({ hdr: () => env.pick((m) => (status.textContent = m)) }, 'hdr').name('Load environment .hdr…');
  lighting.add(state, 'environmentRotation', -180, 180, 1).name('Environment rotation').onChange((v: number) => env.setRotation(v));
  lighting.add(state, 'hdrBackground').name('Show .hdr as background').onChange((v: boolean) => env.setBackground(v));
  lighting.add(state, 'lightIntensity', 0, 10, 0.1).name('Light intensity').onChange(applyParams);
  lighting.add(state, 'lightBehind').name('Light behind cloth').onChange(applyParams);
  lighting.add(state, 'lightAzimuth', -180, 180, 1).name('Light azimuth').onChange(applyParams);
  lighting.add(state, 'lightElevation', 5, 90, 1).name('Light elevation').onChange(applyParams);
  lighting
    .add(
      {
        backlit: () => {
          // Look at the light through the cloth to see the diffraction cross.
          state.lightBehind = true;
          state.lightElevation = 75;
          state.lightAzimuth = 90;
          gui.controllersRecursive().forEach((c) => c.updateDisplay());
          applyParams();
          camera.position.copy(light.position).multiplyScalar(-0.8);
          controls.target.set(0, 0, 0);
        },
      },
      'backlit',
    )
    .name('View against the light');
  const motion = gui.addFolder('Motion');
  motion.add(state, 'animate').name('Animate');
  motion.add(state, 'waves', 0, 0.2, 0.005).name('Wave height').onChange(applyParams);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // GPU render time needs the "timestamp-query" feature; without it the label says "GPU n/a".
  const gpuTiming = renderer.hasFeature('timestamp-query');
  const fps = createFpsCounter(document.getElementById('fps')!, 500, gpuTiming);
  let time = 0;
  let last = performance.now();
  cloth.update(0);
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    if (state.animate) {
      time += (now - last) / 1000;
      cloth.update(time);
    }
    last = now;
    controls.update();
    renderer.render(scene, camera);
    // GPU render time from timestamp queries, where the browser exposes them ("timestamp-query").
    if (gpuTiming) void renderer.resolveTimestampsAsync('render').then(fps.gpu);
    fps.tick();
  });
}

start().catch((e: unknown) => {
  status.textContent = `Failed to start: ${(e as Error).message}`;
  console.error(e);
});
