# fabric-shading

Realistic, real-time cloth rendering for the browser and mid to high end mobile devices, built on three.js and WebGPU.

The goal is a drop-in library for existing three.js apps: a fabric material that looks like real woven or knitted cloth (yarn highlights, glints, soft internal scattering, light through sheer fabric) while holding 60 fps on a Pixel 8. A companion editor generates and bakes the procedural fabric textures in the browser.

> **Status:** early development. The rendering approach is designed; the editor and material are being built. Cloth simulation (grabbing, cheap self-collision) is a later phase.

## Targets

- **APIs:** current stable web standards only. WebGPU through three.js `WebGPURenderer` and TSL node materials. No WebGL fallback, nothing behind experimental flags.
- **Devices:** Pixel 8 (Chrome, Android) as the reference device, iPad M2 (Safari) as a secondary one.
- **Performance:** 60 fps on the default quality tier, 30 fps on the high quality tier.
- **Fabrics:** woven (plain, twill, satin) and knitted (jersey, rib, garter, seed).

## How it works

Everything heavy is baked once in the editor with WebGPU compute shaders. At runtime each pixel only reads a handful of small textures (about 10 on the default tier) and evaluates a few analytic lobes.

| Layer | Technique | Based on |
| --- | --- | --- |
| Yarn structure | Weave and knit pattern maps: yarn tangent, across-yarn and along-yarn coordinates, height, gap mask | Surface-based fabric models |
| Specular highlights without shimmer | Multi-scale SGGX normal distributions per yarn segment, picked by pixel footprint | Yang et al. 2026 |
| Internal scattering | Fiber lobes aggregated into yarn forward and backward lobes in closed form from fiber count, twist and density | Zhu et al. 2023 |
| Opacity and transmission | Two-layer reflection and transmission correction; separable weave-gap diffraction for back-lit sheer fabric | Yu et al. 2025 |
| Glints and irregularity | Baked, spectrally shaped wave-optics noise tiles | Yu et al. 2025 |

## Planned layout

```
packages/
  core/      the three.js fabric material (TSL) and asset loader
  editor/    in-browser pattern editor and baker
examples/    a cloth plane demo, front-lit and back-lit
presets/     baked fabric presets (silk, cotton, wool, polyester, knits)
```

## Roadmap

1. Texture editor and baker: weave and knit pattern generator, specular tables, noise tiles, lookup tables, presets.
2. Fabric material on an animated plane, with environment lighting, profiled on device.
3. Package as a library with a small API, docs and examples.
4. Cloth simulation with user interaction and cheap self-collision.

## References

- Yunchen Yu, Bruce Walter, Steve Marschner, Andrea Weidlich. *Realistic Cloth Rendering with a Ray-Wave Hybrid Shading Model.* ACM Transactions on Graphics 44(6), 2025. [doi:10.1145/3763359](https://doi.org/10.1145/3763359)
- Tianyi Yang, Meng Duan, Zixuan Li, Beibei Wang. *Real-time woven fabric rendering using SGGX fitting.* Computational Visual Media 12(1), 2026. [doi:10.26599/CVM.2025.9450445](https://doi.org/10.26599/CVM.2025.9450445)
- Junqiu Zhu, Zahra Montazeri, Jean-Marie Aubry, Ling-Qi Yan, Andrea Weidlich. *A Practical and Hierarchical Yarn-based Shading Model for Cloth.* Computer Graphics Forum 42(4), EGSR 2023.

## License

[MIT](LICENSE)
