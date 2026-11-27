import { EquirectangularReflectionMapping, PMREMGenerator, type Scene, type Texture, type WebGPURenderer } from 'three/webgpu';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import defaultHdrUrl from '../../../assets/environments/sky-752-1k.hdr?url';

/**
 * Image-based lighting from an equirectangular .hdr: the default sky, or a file the user picks.
 * The PMREM version lights the cloth; the equirect itself can be shown as the background.
 */
export function createEnvironment(renderer: WebGPURenderer, scene: Scene) {
  const pmrem = new PMREMGenerator(renderer);
  const loader = new HDRLoader();
  let equirect: Texture | undefined;
  let lighting: Texture | undefined;
  let showBackground = false;
  const fallbackBackground = scene.background;

  async function load(url: string): Promise<void> {
    const next = await loader.loadAsync(url);
    next.mapping = EquirectangularReflectionMapping;
    const nextLighting = pmrem.fromEquirectangular(next).texture;
    equirect?.dispose();
    lighting?.dispose();
    equirect = next;
    lighting = nextLighting;
    scene.environment = lighting;
    setBackground(showBackground);
  }

  /** Turns the environment (and the background with it) around the vertical axis. */
  function setRotation(degrees: number): void {
    scene.environmentRotation.set(0, (degrees * Math.PI) / 180, 0);
    scene.backgroundRotation.copy(scene.environmentRotation);
  }

  function setBackground(on: boolean): void {
    showBackground = on;
    scene.background = on && equirect ? equirect : fallbackBackground;
  }

  /** Loads a user-picked .hdr file; rejects if it is not a Radiance HDR image. */
  async function loadFile(file: File): Promise<void> {
    const url = URL.createObjectURL(file);
    try {
      await load(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Opens a file picker for a .hdr and loads the chosen file. */
  function pick(onError: (message: string) => void): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.hdr';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) loadFile(file).catch((e: unknown) => onError(`Could not load ${file.name}: ${e instanceof Error ? e.message : String(e)}`));
    };
    input.click();
  }

  return { loadDefault: () => load(defaultHdrUrl), loadFile, pick, setBackground, setRotation };
}
