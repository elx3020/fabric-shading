import { BufferAttribute, SphereGeometry, type BufferGeometry } from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/**
 * Preview shapes for the cloth. Their UVs are scaled so that one UV unit spans `width` world
 * units on every shape, so "repeats" means the same weave size on the cloth, the sphere and the box.
 */

function scaleUvs(geometry: BufferGeometry, su: number, sv: number): BufferGeometry {
  const uv = geometry.attributes.uv as BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return geometry;
}

export function sphereGeometry(width: number, radius = 0.4 * width): BufferGeometry {
  const geometry = new SphereGeometry(radius, 160, 80);
  // Around the equator the UVs run 0..1 over 2 pi r, pole to pole over pi r.
  return scaleUvs(geometry, (2 * Math.PI * radius) / width, (Math.PI * radius) / width);
}

export function roundedBoxGeometry(width: number, side = 0.6 * width, radius = 0.12 * side): BufferGeometry {
  const geometry = new RoundedBoxGeometry(side, side, side, 8, radius);
  return scaleUvs(geometry, side / width, side / width);
}
