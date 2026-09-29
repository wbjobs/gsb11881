import { GpuParticleSystem } from './gpu-particles.js';
import { WorkerClient } from './worker-client.js';

const workerUrl = new URL('./cpu-validate.worker.js', import.meta.url);

function maximumDifference(left, right) {
  const length = Math.min(left.length, right.length);
  let max = 0;
  let firstMismatch = -1;

  for (let index = 0; index < length; index += 1) {
    const difference = Math.abs(left[index] - right[index]);
    if (difference > max) {
      max = difference;
      firstMismatch = index;
    }
  }

  return { max, firstMismatch, length };
}

function isFiniteArray(values) {
  for (let index = 0; index < values.length; index += 1) {
    if (!Number.isFinite(values[index])) return false;
  }
  return true;
}

export async function validateCpuGpuConsistency(options = {}) {
  const count = options.count ?? 4096;
  const steps = options.steps ?? 120;
  const bounds = options.bounds;
  const params = options.params;
  const dynamicStep = Math.floor(steps / 2);
  const dynamicParams = options.dynamicParams ?? {
    ...params,
    gravityY: -14,
    windX: -5,
    restitution: 0.5,
    drag: 0.2,
    attractorStrength: 6000
  };

  const client = new WorkerClient(workerUrl);
  const cpuResultPromise = client.request({
    type: 'validate',
    id: 1,
    count,
    steps,
    dynamicStep,
    params,
    dynamicParams,
    bounds
  });

  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  canvas.style.position = 'fixed';
  canvas.style.left = '-10000px';
  document.body.appendChild(canvas);

  let system;
  try {
    const { createParticleStorage } = await import('./physics.js');
    const initial = createParticleStorage(count, bounds, 1337);
    system = new GpuParticleSystem(canvas, {
      capacity: count,
      activeCount: count,
      positions: initial.positions,
      velocities: initial.velocities,
      params
    });

    for (let index = 0; index < steps; index += 1) {
      if (index === dynamicStep) system.setParams(dynamicParams);
      system.step(false);
    }
    system.gl.finish();
    const gpuResult = system.readParticles(count);
    const cpuResult = await cpuResultPromise;

    const positionComparison = maximumDifference(cpuResult.positions, gpuResult.positions);
    const velocityComparison = maximumDifference(cpuResult.velocities, gpuResult.velocities);
    const tolerance = options.tolerance ?? { position: 0.025, velocity: 0.08 };
    const passed = positionComparison.max <= tolerance.position
      && velocityComparison.max <= tolerance.velocity
      && isFiniteArray(gpuResult.positions)
      && isFiniteArray(gpuResult.velocities);

    return {
      passed,
      count,
      steps,
      tolerance,
      position: positionComparison,
      velocity: velocityComparison,
      sample: {
        cpuPosition: Array.from(cpuResult.positions.slice(0, 4)),
        gpuPosition: Array.from(gpuResult.positions.slice(0, 4)),
        cpuVelocity: Array.from(cpuResult.velocities.slice(0, 4)),
        gpuVelocity: Array.from(gpuResult.velocities.slice(0, 4))
      }
    };
  } finally {
    system?.dispose();
    canvas.remove();
    client.dispose();
  }
}
