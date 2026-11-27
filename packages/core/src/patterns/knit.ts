import { hash01 } from './hash.ts';
import { MAX_REPEAT, YarnKind, yarnNormal, type WeaveSample } from './weave.ts';
import type { Vec3 } from './octahedral.ts';

/** K = knit stitch (V legs on this side), P = purl stitch (loop heads and sinkers on this side). */
export type Stitch = 'K' | 'P';

/** A weft-knit repeat: `stitches[row][col]`, rows are courses (bottom to top), cols are wales. */
export interface KnitPattern {
  readonly name: string;
  readonly rows: number;
  readonly cols: number;
  readonly stitches: readonly (readonly Stitch[])[];
}

function build(name: string, rows: number, cols: number, at: (row: number, col: number) => Stitch): KnitPattern {
  if (rows < 1 || cols < 1 || rows > MAX_REPEAT || cols > MAX_REPEAT) {
    throw new RangeError(`Knit repeat must be 1..${MAX_REPEAT} in each direction, got ${rows}x${cols}`);
  }
  return { name, rows, cols, stitches: Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => at(r, c))) };
}

/** Stockinette. `face` shows the V side, otherwise the reverse (purl bumps). */
export function jerseyKnit(face = true): KnitPattern {
  return build(face ? 'jersey' : 'reverse jersey', 1, 1, () => (face ? 'K' : 'P'));
}

/** Rib: `knit` knit wales then `purl` purl wales, e.g. 1x1 or 2x2. */
export function ribKnit(knit = 1, purl = 1): KnitPattern {
  if (knit < 1 || purl < 1) throw new RangeError('Rib needs knit >= 1 and purl >= 1');
  return build(`rib ${knit}x${purl}`, 1, knit + purl, (_, c) => (c < knit ? 'K' : 'P'));
}

/** Garter: knit and purl courses alternate. */
export function garterKnit(): KnitPattern {
  return build('garter', 2, 1, (r) => (r % 2 === 0 ? 'K' : 'P'));
}

/** Seed (moss): knit and purl alternate in both directions. */
export function seedKnit(): KnitPattern {
  return build('seed', 2, 2, (r, c) => ((r + c) % 2 === 0 ? 'K' : 'P'));
}

export interface KnitParams {
  /** Stitch width relative to course height (typical jersey gauge is about 1.3). */
  stitchAspect: number;
  /** Yarn radius relative to course height, 0.12..0.32. */
  yarnRadius: number;
  /** How far legs rise over heads and sinkers, 0..1. */
  relief: number;
  /** Per-stitch variation of loop shape and yarn thickness, 0..1. */
  irregularity: number;
  seed: number;
}

export const defaultKnitParams: KnitParams = {
  stitchAspect: 1.3,
  yarnRadius: 0.22,
  relief: 0.7,
  irregularity: 0.2,
  seed: 1,
};

type P2 = [number, number];

/** One yarn piece of a stitch: a cubic in stitch-local units with a depth profile. */
interface Piece {
  ctrl: [P2, P2, P2, P2];
  /** Depth at both ends and the bump added in the middle, in units of `relief`. */
  depth: [number, number, number];
  /** Along-yarn parameter range of this piece within the stitch, 0..1. */
  along: [number, number];
}

/**
 * Knit stitch seen from the face, in units where a course is 1 high and a stitch is `w` wide.
 * The course yarn runs: left leg up, head across the top (tucked behind the next course),
 * right leg down, sinker across the bottom into the next stitch.
 */
function knitPieces(w: number): Piece[] {
  const c = w / 2;
  return [
    { ctrl: [[c - 0.1 * w, -0.28], [c - 0.22 * w, 0.15], [c - 0.44 * w, 0.6], [c - 0.32 * w, 0.98]], depth: [-0.6, -0.6, 1.6], along: [0.1, 0.35] },
    { ctrl: [[c - 0.32 * w, 0.98], [c - 0.34 * w, 1.26], [c + 0.34 * w, 1.26], [c + 0.32 * w, 0.98]], depth: [-0.6, -0.6, -0.3], along: [0.35, 0.65] },
    { ctrl: [[c + 0.32 * w, 0.98], [c + 0.44 * w, 0.6], [c + 0.22 * w, 0.15], [c + 0.1 * w, -0.28]], depth: [-0.6, -0.6, 1.6], along: [0.65, 0.9] },
    { ctrl: [[c + 0.1 * w, -0.28], [c + 0.3 * w, -0.5], [c + 0.7 * w, -0.5], [c + 0.9 * w, -0.28]], depth: [-0.6, -0.6, -0.3], along: [0.9, 1.1] },
  ];
}

const SEGMENTS = 24;

interface Polyline {
  /** x, y, depth per point, in physical units (course height = 1). */
  pts: Float64Array;
  along: [number, number];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  radius: number;
  row: number;
}

function cubic(p: [P2, P2, P2, P2], t: number): P2 {
  const s = 1 - t;
  const a = s * s * s;
  const b = 3 * s * s * t;
  const cc = 3 * s * t * t;
  const d = t * t * t;
  return [a * p[0][0] + b * p[1][0] + cc * p[2][0] + d * p[3][0], a * p[0][1] + b * p[1][1] + cc * p[2][1] + d * p[3][1]];
}

/** Precompute every yarn piece in the repeat as a polyline, in physical units. */
function tessellate(pattern: KnitPattern, p: KnitParams): Polyline[] {
  const w = p.stitchAspect;
  const out: Polyline[] = [];
  for (let row = 0; row < pattern.rows; row++) {
    const radius = p.yarnRadius * (1 + p.irregularity * 0.2 * (hash01(row, p.seed * 31 + 5) - 0.5));
    for (let col = 0; col < pattern.cols; col++) {
      const sign = pattern.stitches[row]![col] === 'K' ? 1 : -1;
      const stitchId = row * pattern.cols + col;
      const jx = p.irregularity * 0.06 * (hash01(stitchId, p.seed * 17 + 1) - 0.5);
      const jy = p.irregularity * 0.06 * (hash01(stitchId, p.seed * 17 + 2) - 0.5);
      const spread = 1 + p.irregularity * 0.15 * (hash01(stitchId, p.seed * 17 + 3) - 0.5);
      for (const piece of knitPieces(w)) {
        const pts = new Float64Array((SEGMENTS + 1) * 3);
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i <= SEGMENTS; i++) {
          const t = i / SEGMENTS;
          const [lx, ly] = cubic(piece.ctrl, t);
          const x = col * w + w / 2 + (lx - w / 2) * spread + jx;
          const y = row + ly + jy;
          // A purl stitch is the same loop seen from the back: depth flips.
          const depth = sign * ((1 - t) * piece.depth[0] + t * piece.depth[1] + piece.depth[2] * Math.sin(Math.PI * t));
          pts[i * 3] = x;
          pts[i * 3 + 1] = y;
          pts[i * 3 + 2] = depth * p.relief * radius;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
        out.push({ pts, along: piece.along, minX: minX - radius, maxX: maxX + radius, minY: minY - radius, maxY: maxY + radius, radius, row });
      }
    }
  }
  return out;
}

/** Physical width / height of one repeat. */
export function knitAspect(pattern: KnitPattern, p: KnitParams): number {
  return (pattern.cols * p.stitchAspect) / pattern.rows;
}

export function maxKnitHeight(p: KnitParams): number {
  const r = p.yarnRadius * 1.1;
  return 1.6 * p.relief * r + r;
}

/**
 * Builds a sampler for the repeat. Tessellation happens once, so call this per bake,
 * then evaluate the returned function per texel at (u, v) in [0, 1).
 */
export function knitSampler(pattern: KnitPattern, p: KnitParams): (u: number, v: number) => WeaveSample {
  const lines = tessellate(pattern, p);
  const W = pattern.cols * p.stitchAspect;
  const H = pattern.rows;
  const floor = -maxKnitHeight(p);

  return (u, v) => {
    let best: WeaveSample = { kind: YarnKind.None, tangent: [0, 0, 1], h: 0, z: 0, yarnId: 0, height: floor, normal: [0, 0, 1] };
    const px0 = u * W;
    const py0 = v * H;
    // Pieces reach into neighbouring repeats, so test the point against 3x3 tiled copies.
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const px = px0 + ox * W;
        const py = py0 + oy * H;
        for (const line of lines) {
          if (px < line.minX || px > line.maxX || py < line.minY || py > line.maxY) continue;
          const pts = line.pts;
          let bestD2 = Infinity;
          let bestI = 0;
          let bestT = 0;
          for (let i = 0; i < SEGMENTS; i++) {
            const ax = pts[i * 3]!, ay = pts[i * 3 + 1]!;
            const bx = pts[i * 3 + 3]!, by = pts[i * 3 + 4]!;
            const dx = bx - ax, dy = by - ay;
            const len2 = dx * dx + dy * dy;
            const t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2));
            const ex = ax + dx * t - px;
            const ey = ay + dy * t - py;
            const d2 = ex * ex + ey * ey;
            if (d2 < bestD2) { bestD2 = d2; bestI = i; bestT = t; }
          }
          const r = line.radius;
          if (bestD2 > r * r) continue;
          const i = bestI;
          const ax = pts[i * 3]!, ay = pts[i * 3 + 1]!, az = pts[i * 3 + 2]!;
          const bx = pts[i * 3 + 3]!, by = pts[i * 3 + 4]!, bz = pts[i * 3 + 5]!;
          const center = az + (bz - az) * bestT;
          const across = Math.sqrt(bestD2) / r;
          const height = center + r * Math.sqrt(Math.max(0, 1 - across * across));
          if (height <= best.height) continue;
          const tx = bx - ax, ty = by - ay, tz = bz - az;
          const tl = Math.hypot(tx, ty, tz);
          // Signed across-yarn position: which side of the yarn direction the point lies on.
          const side = tx * (py - ay) - ty * (px - ax) >= 0 ? 1 : -1;
          const t01 = (i + bestT) / SEGMENTS;
          const along = line.along[0] + (line.along[1] - line.along[0]) * t01;
          const stitchCol = Math.floor((ax + bx) / 2 / p.stitchAspect);
          const z = (((stitchCol + along) / pattern.cols) % 1 + 1) % 1;
          const tangent: Vec3 = [tx / tl, ty / tl, tz / tl];
          // h grows toward the left of the yarn direction, (-ty, tx) in the fabric plane.
          const pl = Math.hypot(tx, ty) || 1;
          const normal = yarnNormal(tangent, [-ty / pl, tx / pl, 0], side * across, 1);
          best = { kind: YarnKind.Loop, tangent, h: side * across, z, yarnId: line.row, height, normal };
        }
      }
    }
    return best;
  };
}
