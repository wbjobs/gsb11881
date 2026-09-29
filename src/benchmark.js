import { GpuParticleSystem } from './gpu-particles.js';
import { WorkerClient } from './worker-client.js';
import { PerformanceMonitor } from './performance-monitor.js';

const workerUrl = new URL('./cpu-benchmark.worker.js', import.meta.url);
const factoryUrl = new URL('./data-factory.worker.js', import.meta.url);

export function createParticleData(capacity, bounds) {
  const client = new WorkerClient(factoryUrl);
  const promise = client.request({
    type: 'create',
    capacity,
    bounds,
    seed: 1337
  }).then((message) => {
    client.dispose();
    return { positions: message.positions, velocities: message.velocities };
  }).catch((error) => {
    client.dispose();
    throw error;
  });

  return promise;
}

export function runCpuBenchmark({ capacity, frames = 180, params, bounds }) {
  const client = new WorkerClient(workerUrl);
  client.post({ type: 'benchmark', capacity, frames, params, bounds, seed: 1337 });

  return new Promise((resolve, reject) => {
    const remove = client.listen((message) => {
      if (message.type === 'benchmark-result') {
        remove();
        client.dispose();
        resolve(message);
      }
      if (message.type === 'error') {
        remove();
        client.dispose();
        reject(new Error(message.message));
      }
    });
  });
}

export async function runGpuBenchmark({ capacity, frames = 180, params, bounds }, data) {
  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 540;
  canvas.style.position = 'fixed';
  canvas.style.left = '-10000px';
  document.body.appendChild(canvas);

  let system;
  try {
    system = new GpuParticleSystem(canvas, {
      capacity,
      activeCount: capacity,
      positions: data.positions,
      velocities: data.velocities,
      params,
      pointSize: 1
    });

    const samples = [];
    const started = performance.now();

    for (let frame = 0; frame < frames; frame += 1) {
      const frameStart = performance.now();
      system.step(false);
      samples.push(performance.now() - frameStart);
      if (frame % 8 === 7) system.timerQueries.poll();
    }

    system.gl.finish();
    const totalMs = performance.now() - started;
    const summary = PerformanceMonitor.summarize(samples);

    return {
      type: 'benchmark-result',
      backend: 'gpu-transform-feedback',
      renderer: system.gl.getParameter(system.gl.RENDERER),
      capacity,
      frames,
      totalMs,
      meanMs: summary.mean,
      p50Ms: summary.p50,
      p95Ms: summary.p95,
      maxMs: summary.max,
      particleStepsPerSecond: capacity * frames * 1000 / totalMs,
      memoryBytes: system.memoryBytes
    };
  } finally {
    system?.dispose();
    canvas.remove();
  }
}

export function compareBenchmarks(cpu, gpu) {
  const speedup = cpu.totalMs / gpu.totalMs;
  const particleSpeedup = gpu.particleStepsPerSecond / cpu.particleStepsPerSecond;
  return {
    speedup,
    particleSpeedup,
    cpuP95Ms: cpu.p95Ms,
    gpuP95Ms: gpu.p95Ms,
    verdict: speedup >= 2 ? 'gpu-significantly-faster' : 'gpu-measured'
  };
}
