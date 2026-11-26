import { hash01 } from './hash.ts';
import type { Vec3 } from './octahedral.ts';

/**
 * A woven pattern repeat: `warpUp[row][col]` is true where the warp yarn
 * (running along +v) lies over the weft yarn (running along +u).
 */
export interface WeavePattern {
  readonly name: string;
  readonly rows: number;
  readonly cols: number;
  readonly warpUp: readonly (readonly boolean[])[];
}

export const MAX_REPEAT = 64;

function build(name: string, rows: number, cols: number, up: (row: number, col: number) => boolean): WeavePattern {
  if (rows < 1 || cols < 1 || rows > MAX_REPEAT || cols > MAX_REPEAT) {
    throw new RangeError(`Weave repeat must be 1..${MAX_REPEAT} in each direction, got ${rows}x${cols}`);
  }
  const warpUp = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => up(r, c)));
  return { name, rows, cols, warpUp };
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

export function plainWeave(): WeavePattern {
  return build('plain', 2, 2, (r, c) => (r + c) % 2 === 0);
}

/** Twill with `over` warp floats and `under` weft floats, stepping one end per pick. */
export function twillWeave(over = 2, under = 2, direction: 1 | -1 = 1): WeavePattern {
  if (over < 1 || under < 1) throw new RangeError('Twill needs over >= 1 and under >= 1');
  const n = over + under;
  return build(`twill ${over}/${under}`, n, n, (r, c) => mod(c - direction * r, n) < over);
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Satin of `n` ends with move number `step`. Warp-faced satin shows long warp
 * floats with one weft interlacing per row; weft-faced is the inverse.
 */
export function satinWeave(n = 5, step = 2, warpFaced = true): WeavePattern {
  if (n < 5) throw new RangeError('Satin needs at least 5 ends');
  if (step <= 1 || step >= n - 1 || gcd(n, step) !== 1) {
    throw new RangeError(`Satin step ${step} must be coprime with ${n} and between 2 and ${n - 2}`);
  }
  return build(`satin ${n}/${step}`, n, n, (r, c) => {
    const interlace = mod(r * step, n) === c;
    return warpFaced ? !interlace : interlace;
  });
}

export interface WeaveParams {
  /** Warp yarn width as a fraction of the cell, 0.2..1. */
  warpWidth: number;
  /** Weft yarn width as a fraction of the cell, 0.2..1. */
  weftWidth: number;
  /** How far yarns bend over and under each other, 0..1. */
  crimp: number;
  /** Yarn cross-section height relative to its half-width, 0.2..1 (1 = round). */
  flatness: number;
  /** Per-yarn variation of width and position, 0..1. */
  irregularity: number;
  /** Seed for the irregularity hash. */
  seed: number;
}

export const defaultWeaveParams: WeaveParams = {
  warpWidth: 0.9,
  weftWidth: 0.9,
  crimp: 0.5,
  flatness: 0.6,
  irregularity: 0.2,
  seed: 1,
};

export const YarnKind = {
  None: 0,
  Warp: 1,
  Weft: 2,
  /** A knitted loop; every course is its own yarn pass. */
  Loop: 3,
} as const;
export type YarnKind = (typeof YarnKind)[keyof typeof YarnKind];

/** Everything the material needs to know about the yarn seen at one point of the repeat. */
export interface WeaveSample {
  kind: YarnKind;
  /** Yarn tangent in fabric space (x = u, y = v, z = up), unit length. */
  tangent: Vec3;
  /** Across-yarn position, -1..1 from one edge to the other. */
  h: number;
  /** Along-yarn position as a fraction of the repeat, 0..1. */
  z: number;
  /** Yarn index within the repeat: warp column, weft row, or knit course. */
  yarnId: number;
  /** Surface height in cell units (cell = 1). */
  height: number;
}

interface YarnShape {
  offset: number;
  halfWidth: number;
}

function yarnShape(width: number, index: number, salt: number, p: WeaveParams): YarnShape {
  const jitterW = 1 + p.irregularity * 0.25 * (hash01(index, p.seed * 7 + salt) - 0.5);
  const jitterO = p.irregularity * 0.12 * (hash01(index, p.seed * 13 + salt + 1) - 0.5);
  return { offset: jitterO, halfWidth: Math.min(0.5, (width * jitterW) / 2) };
}

/** Crimp profile: cosine blend between the up/down levels at neighbouring cell centres. */
function crimpProfile(alongCells: number, level: (k: number) => number): { center: number; slope: number } {
  const s = alongCells - 0.5;
  const k0 = Math.floor(s);
  const f = s - k0;
  const c0 = level(k0);
  const c1 = level(k0 + 1);
  const w = (1 - Math.cos(Math.PI * f)) / 2;
  return {
    center: c0 + (c1 - c0) * w,
    slope: (c1 - c0) * (Math.PI / 2) * Math.sin(Math.PI * f),
  };
}

/** Largest surface height a sample can reach, used to normalise height maps. */
export function maxWeaveHeight(p: WeaveParams): number {
  const rWarp = (p.warpWidth / 2) * 1.25;
  const rWeft = (p.weftWidth / 2) * 1.25;
  return Math.max(p.crimp * rWeft + rWarp * p.flatness, p.crimp * rWarp + rWeft * p.flatness);
}

/** Evaluate the pattern at repeat coordinates (u, v) in [0, 1). */
export function sampleWeave(pattern: WeavePattern, p: WeaveParams, u: number, v: number): WeaveSample {
  const { rows, cols, warpUp } = pattern;
  const x = u * cols;
  const y = v * rows;
  const col = mod(Math.floor(x), cols);
  const row = mod(Math.floor(y), rows);
  const fu = x - Math.floor(x);
  const fv = y - Math.floor(y);

  const warp = yarnShape(p.warpWidth, col, 0, p);
  const weft = yarnShape(p.weftWidth, row, 1000, p);
  const hWarp = (fu - 0.5 - warp.offset) / warp.halfWidth;
  const hWeft = (fv - 0.5 - weft.offset) / weft.halfWidth;

  let best: WeaveSample = {
    kind: YarnKind.None,
    tangent: [0, 0, 1],
    h: 0,
    z: 0,
    yarnId: 0,
    height: -maxWeaveHeight(p),
  };

  if (Math.abs(hWarp) <= 1) {
    // Warp runs along v; it is up (+1) where warpUp is true.
    const amp = p.crimp * weft.halfWidth;
    const prof = crimpProfile(y, (k) => (warpUp[mod(k, rows)]![col] ? 1 : -1));
    const height = amp * prof.center + warp.halfWidth * p.flatness * Math.sqrt(1 - hWarp * hWarp);
    const t: Vec3 = [0, 1, amp * prof.slope];
    const len = Math.hypot(t[0], t[1], t[2]);
    best = { kind: YarnKind.Warp, tangent: [0, t[1] / len, t[2] / len], h: hWarp, z: v - Math.floor(v), yarnId: col, height };
  }

  if (Math.abs(hWeft) <= 1) {
    // Weft runs along u; it is up where the warp is down.
    const amp = p.crimp * warp.halfWidth;
    const prof = crimpProfile(x, (k) => (warpUp[row]![mod(k, cols)] ? -1 : 1));
    const height = amp * prof.center + weft.halfWidth * p.flatness * Math.sqrt(1 - hWeft * hWeft);
    if (height > best.height) {
      const t: Vec3 = [1, 0, amp * prof.slope];
      const len = Math.hypot(t[0], t[1], t[2]);
      best = { kind: YarnKind.Weft, tangent: [t[0] / len, 0, t[2] / len], h: hWeft, z: u - Math.floor(u), yarnId: row, height };
    }
  }

  return best;
}
