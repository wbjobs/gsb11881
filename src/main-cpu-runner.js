import { Cpu2dRenderer } from './cpu-renderer.js';
import { createParticleStorage, stepParticles } from './physics.js';

export class MainThreadCpuRunner {
  constructor(canvas, capacity, params) {
    this.canvas = canvas;
    this.capacity = capacity;
    this.activeCount = capacity;
    this.params = params;
    this.running = false;
    this.frameHandle = 0;
    this.renderer = new Cpu2dRenderer(canvas);
    const storage = createParticleStorage(capacity, params.bounds, 1337);
    this.positions = storage.positions;
    this.velocities = storage.velocities;
    this.onStats = null;
    this.lastStatsAt = 0;
    this.statsFrameCount = 0;
  }

  setParams(params) {
    this.params = params;
  }

  post() {}

  start() {
    if (this.running) return;
    this.running = true;
    this.lastStatsAt = performance.now();
    const frame = (now) => {
      if (!this.running) return;
      const frameStart = performance.now();
      stepParticles(this.positions, this.velocities, this.activeCount, this.params);
      this.renderer.render(
        this.positions,
        this.velocities,
        this.activeCount,
        this.params,
        this.canvas.width,
        this.canvas.height
      );

      const physicsMs = performance.now() - frameStart;
      const statsNow = performance.now();
      this.statsFrameCount += 1;
      if (statsNow - this.lastStatsAt >= 500) {
        this.onStats?.({
          fps: this.statsFrameCount * 1000 / (statsNow - this.lastStatsAt),
          physicsMs,
          renderMs: 0,
          activeCount: this.activeCount,
          rendererType: 'main-2d'
        });
        this.lastStatsAt = statsNow;
        this.statsFrameCount = 0;
      }
      this.frameHandle = requestAnimationFrame(frame);
    };
    this.frameHandle = requestAnimationFrame(frame);
  }

  pause() {
    this.running = false;
    cancelAnimationFrame(this.frameHandle);
  }

  dispose() {
    this.pause();
  }
}
