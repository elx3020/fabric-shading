# @fabric-shading/core

Real-time woven and knitted fabric for three.js on WebGPU. A procedural pattern is baked into small textures and lookup tables. `FabricMaterial`, a TSL node material, then shades them with ordinary three.js lights and `scene.environment`. Its default tier holds 60 fps on an iPad M2.

```sh
npm install @fabric-shading/core three
```

It needs three.js r187 or newer, imported from `three/webgpu`, and a browser with WebGPU on an https page or localhost. There is no WebGL path.

## Quick start

```ts
import { Mesh, PlaneGeometry } from 'three/webgpu';
import { fabricFromPreset } from '@fabric-shading/core';
import { FabricMaterial } from '@fabric-shading/core/material';

const fabric = fabricFromPreset('polyester-satin'); // bakes in about 0.3 s
const material = new FabricMaterial(fabric, { tier: 'default', repeats: 24 });
scene.add(new Mesh(new PlaneGeometry(1, 1), material));
```

The mesh needs UVs and normals. It does not need tangents, because the material builds the fabric frame from screen-space derivatives. Weave direction follows the UV axes, and `repeats` sets how many pattern repeats cover the 0..1 UV range.

## Getting a fabric

| Function | Use |
| --- | --- |
| `fabricFromPreset(id, overrides?)` | One of the built-in fabrics: `fabricPresetIds` lists them, and `wovenPresets` and `knitPresets` describe them. |
| `bakeFabric(spec)` | Your own pattern. `spec.kind` is `'woven'` with a `WeavePattern` (`plainWeave()`, `twillWeave(over, under)`, `satinWeave(n, step)`) or `'knit'` with a `KnitPattern` (`jerseyKnit()`, `ribKnit(knit, purl)`, `garterKnit()`, `seedKnit()`), plus colour, yarn data and bake options. |
| `readFabric(bytes)` / `writeFabric(asset)` | Load or save a `.fabric` file, as exported by the editor app (gzip, a few hundred KB). Loading skips baking. |

A `FabricAsset` holds everything the material needs: the pattern maps, specular moment mips, noise tiles, the two-layer table and the physical shading inputs. Bake once and share it between materials.

## FabricMaterial

```ts
new FabricMaterial(asset, { tier?: 'default' | 'quality', repeats?: number | Vector2 })
```

- `default` tier: one filtered SGGX specular lobe per pixel. This is the 60 fps target.
- `quality` tier: warp and weft (or the two knit legs) keep separate lobes, for sharper anisotropic highlights. This is the 30 fps target on phones.

Live parameters are TSL uniforms on `material.fabric`, so changing `.value` needs no recompile:

| Uniform | Meaning |
| --- | --- |
| `repeats` | Pattern repeats over the UV range (Vector2). |
| `color` | Linear RGB yarn colour. |
| `roughness` | Fiber roughness of the specular lobe. |
| `specular` | Scale of the fiber specular. |
| `glint` | Wave-optics glint strength, 0 to 1. |
| `sheerness` | 0 is opaque; 1 lets light and background through the weave gaps. |
| `ior` | Fiber index of refraction (Fresnel). Set from the yarn data when known. |
| `yarnNormal` | Share of diffuse and transmitted light shaded with the yarn normal, 0 to 1. |
| `sheen`, `sheenRoughness`, `sheenColor` | Fly-away fiber sheen layer: amount 0 to 1, lobe width, fiber colour. Set from the fabric (cotton and wool have more). |
| `lightSize` | Angular radius of the lights in radians (three's lights are points); sets how bright the diffraction cross is. |

What it models:
- SGGX fiber specular, prefiltered so distant cloth does not alias (Yang et al. 2026).
- Wave-optics glints (Yu et al. 2025).
- Light scattering inside the yarn, aggregated from fiber, ply and yarn data (Zhu et al. 2023).
- Bounces between the warp and weft layers.
- Light through the gaps, including the diffraction cross around a light seen through sheer cloth.
- Environment light from behind the cloth, passed on through the yarn.
- A sheen layer for fly-away fibers on top of the cloth (Zeltner et al. 2022, as used by Zhu et al. 2024).

`material.dispose()` frees the fabric's textures. The diffraction table is shared by all materials and stays.

## Lower-level pieces

The bakers are exported for tools and tests. They are `bakeWeaveMaps`, `bakeKnitMaps`, `bakeMomentMips`, `bakeTwoLobeMips`, `bakeWaveNoise`, `bakeTwoLayerLut` and `bakeDiffractionLut`, plus the SGGX helpers. `createFabricTextures` (in `/material`) turns an asset into GPU textures if you write your own node material.

## License

MIT
