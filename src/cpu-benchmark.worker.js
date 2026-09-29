import { createParticleStorage, stepParticles } from './physics.js';

self.onmessage = (event) => {
  const message = event.data;
  if (message.type !== 'benchmark') return;

  const { capacity, frames, bounds, params } = message;
  const storage = createParticleStorage(capacity, bounds, message.seed ?? 1337);
  const samples = [];
  const started = performance.now();

  for (let frame = 0; frame < frames; frame += 1) {
    const frameStart = performance.now();
    stepParticles(storage.positions, storage.velocities, capacity, params);
    samples.push(performance.now() - frameStart);

    if (frame % 30 === 0) {
      self.postMessage({ type: 'benchmark-progress', completed: frame, total: frames });
    }
  }

  const totalMs = performance.now() - started;
  const sorted = [...samples].sort((left, right) => left - right);
  const quantile = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];

  self.postMessage({
    type: 'benchmark-result',
    backend: 'cpu-worker',
    capacity,
    frames,
    totalMs,
    meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    p50Ms: quantile(0.5),
    p95Ms: quantile(0.95),
    maxMs: sorted[sorted.length - 1],
    particleStepsPerSecond: capacity * frames * 1000 / totalMs,
    memoryBytes: storage.positions.byteLength + storage.velocities.byteLength
  });
};
