/**
 * Small frame-rate overlay. Call `tick()` once per rendered frame; the label
 * refreshes twice a second with the average fps, average frame time and the
 * slowest frame in that window (spikes matter more than the average on phones).
 */
export function createFpsCounter(element: HTMLElement, windowMs = 500): { tick(): void } {
  let windowStart = performance.now();
  let last = windowStart;
  let frames = 0;
  let worst = 0;

  return {
    tick(): void {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
      frames++;
      const elapsed = now - windowStart;
      if (elapsed < windowMs) return;
      const fps = (frames * 1000) / elapsed;
      element.textContent = `${fps.toFixed(0)} fps · ${(elapsed / frames).toFixed(1)} ms · worst ${worst.toFixed(1)} ms`;
      element.style.color = fps >= 55 ? '#7d7' : fps >= 28 ? '#ec6' : '#f77';
      windowStart = now;
      frames = 0;
      worst = 0;
    },
  };
}
