export type Vec3 = [number, number, number];

/**
 * Octahedral encoding of a unit vector into two values in [0, 1].
 * Covers the full sphere, so yarn tangents that dip below the surface plane survive.
 */
export function octEncode(v: Vec3): [number, number] {
  const [x, y, z] = v;
  const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z);
  let px = x / l1;
  let py = y / l1;
  if (z < 0) {
    const ox = (1 - Math.abs(py)) * (px >= 0 ? 1 : -1);
    const oy = (1 - Math.abs(px)) * (py >= 0 ? 1 : -1);
    px = ox;
    py = oy;
  }
  return [px * 0.5 + 0.5, py * 0.5 + 0.5];
}

export function octDecode(e: [number, number]): Vec3 {
  const fx = e[0] * 2 - 1;
  const fy = e[1] * 2 - 1;
  const z = 1 - Math.abs(fx) - Math.abs(fy);
  const t = Math.max(-z, 0);
  const x = fx + (fx >= 0 ? -t : t);
  const y = fy + (fy >= 0 ? -t : t);
  const len = Math.hypot(x, y, z);
  return [x / len, y / len, z / len];
}
