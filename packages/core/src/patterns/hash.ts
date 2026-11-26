/**
 * Small deterministic integer hash (PCG-style) mapped to [0, 1).
 * Used for per-yarn irregularity so a pattern bakes identically every time.
 */
export function hash01(n: number, seed = 0): number {
  let state = (Math.imul(n | 0, 747796405) + Math.imul(seed | 0, 2891336453) + 2891336453) >>> 0;
  const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737) >>> 0;
  state = ((word >>> 22) ^ word) >>> 0;
  return state / 4294967296;
}
