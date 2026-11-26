/**
 * Small frame-rate overlay. Call `tick()` once per rendered frame; the label
 * refreshes twice a second with the average fps, average frame time and the
 * slowest frame in that window (spikes matter more than the average on phones).
 *
 * Frame time is capped by vsync (16.7 ms at 60 Hz), so it hides how much room is left.
 * Pass GPU times to `gpu()` (from timestamp queries) to show the GPU's own render time.
 */
export function createFpsCounter(element: HTMLElement, windowMs = 500, gpuAvailable = true): { tick(): void; gpu(ms: number | undefined): void } {
  let windowStart = performance.now();
  let last = windowStart;
  let frames = 0;
  let worst = 0;
  let gpuSum = 0;
  let gpuCount = 0;
  let gpuLabel = gpuAvailable ? '' : ' · GPU n/a';

  return {
    gpu(ms: number | undefined): void {
      if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return;
      gpuSum += ms;
      gpuCount++;
    },
    tick(): void {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
      frames++;
      const elapsed = now - windowStart;
      if (elapsed < windowMs) return;
      const fps = (frames * 1000) / elapsed;
      if (gpuCount > 0) gpuLabel = ` · GPU ${(gpuSum / gpuCount).toFixed(1)} ms`;
      element.textContent = `${fps.toFixed(0)} fps · ${(elapsed / frames).toFixed(1)} ms · worst ${worst.toFixed(1)} ms${gpuLabel}`;
      element.style.color = fps >= 55 ? '#7d7' : fps >= 28 ? '#ec6' : '#f77';
      windowStart = now;
      frames = 0;
      worst = 0;
      gpuSum = 0;
      gpuCount = 0;
    },
  };
}
