import { BufferAttribute, PlaneGeometry, SphereGeometry, type BufferGeometry } from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/**
 * Preview shapes for the cloth. Their UVs are scaled so that one UV unit spans `width` world
 * units on every shape, so "repeats" means the same weave size on the plane, the sphere and the box.
 */
export type ShapeName = 'hill' | 'sphere' | 'rounded box';
export const shapeNames: readonly ShapeName[] = ['hill', 'sphere', 'rounded box'];

function scaleUvs(geometry: BufferGeometry, su: number, sv: number): BufferGeometry {
  const uv = geometry.attributes.uv as BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return geometry;
}

/** A square sheet draped over a smooth hill: raised cosine in the distance from the centre, flat at the corners. */
export function hillGeometry(width: number, height = 0.22 * width, segments = 160): BufferGeometry {
  const geometry = new PlaneGeometry(width, width, segments, segments);
  const pos = geometry.attributes.position as BufferAttribute;
  const reach = (width / 2) * Math.SQRT2;
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getY(i)) / reach;
    pos.setZ(i, height * 0.5 * (1 + Math.cos(Math.PI * Math.min(r, 1))));
  }
  geometry.translate(0, 0, -height / 2);
  geometry.computeVertexNormals();
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

export function shapeGeometry(shape: ShapeName, width: number): BufferGeometry {
  switch (shape) {
    case 'hill':
      return hillGeometry(width);
    case 'sphere':
      return sphereGeometry(width);
    case 'rounded box':
      return roundedBoxGeometry(width);
  }
}
