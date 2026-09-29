export class PerformanceMonitor {
  constructor() {
    this.frameCount = 0;
    this.lastSample = performance.now();
    this.fps = 0;
    this.frameMs = 0;
    this.longTasks = 0;
    this.longTaskMs = 0;
    this.maxLongTaskMs = 0;
    this.workerMs = null;
    this.gpuMs = null;
    this.updateMs = 0;
    this.renderMs = 0;

    this.longTaskObserver = null;
    if ('PerformanceObserver' in globalThis) {
      try {
        this.longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            this.longTasks++;
            this.longTaskMs += entry.duration;
            this.maxLongTaskMs = Math.max(this.maxLongTaskMs, entry.duration);
          }
        });
        this.longTaskObserver.observe({ entryTypes: ['longtask'] });
      } catch {
        this.longTaskObserver = null;
      }
    }
  }

  beginFrame() {
    this.frameStart = performance.now();
    this.updateStart = 0;
    this.updateDuration = 0;
  }

  beginUpdate() {
    this.updateStart = performance.now();
  }

  endUpdate() {
    this.updateDuration = performance.now() - this.updateStart;
  }

  endFrame(renderBeganAt) {
    const now = performance.now();
    this.frameCount++;
    this.frameMs = exponentialAverage(this.frameMs || 16.7, now - this.frameStart, 0.08);
    this.updateMs = exponentialAverage(this.updateMs || 1, this.updateDuration, 0.08);
    this.renderMs = exponentialAverage(this.renderMs || 1, now - renderBeganAt, 0.08);

    const elapsed = now - this.lastSample;
    if (elapsed >= 500) {
      this.fps = (this.frameCount * 1000) / elapsed;
      this.frameCount = 0;
      this.lastSample = now;
    }
  }

  setWorker(stepMs) {
    this.workerMs = exponentialAverage(this.workerMs ?? stepMs, stepMs, 0.12);
  }

  setGpu(seconds) {
    if (Number.isFinite(seconds)) {
      this.gpuMs = exponentialAverage(this.gpuMs ?? seconds * 1000, seconds * 1000, 0.12);
    }
  }

  snapshot() {
    return {
      fps: this.fps,
      frameMs: this.frameMs,
      updateMs: this.updateMs,
      renderMs: this.renderMs,
      workerMs: this.workerMs,
      gpuMs: this.gpuMs,
      longTasks: this.longTasks,
      longTaskMs: this.longTaskMs,
      maxLongTaskMs: this.maxLongTaskMs
    };
  }

  dispose() {
    this.longTaskObserver?.disconnect();
  }
}

function exponentialAverage(previous, next, alpha) {
  return previous * (1 - alpha) + next * alpha;
}

export function nowSeconds() {
  return performance.now() / 1000;
}

export function formatMilliseconds(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1) return `${(value * 1000).toFixed(0)}μs`;
  return `${value.toFixed(2)}ms`;
}
