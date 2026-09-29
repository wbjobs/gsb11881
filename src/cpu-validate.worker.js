import {
  createParticleStorage,
  stepParticles
} from './physics.js';

self.onmessage = (event) => {
  const message = event.data;
  if (message.type !== 'validate') return;

  const storage = createParticleStorage(message.count, message.bounds, message.seed ?? 1337);
  for (let index = 0; index < message.steps; index += 1) {
    const params = index === message.dynamicStep ? message.dynamicParams : message.params;
    stepParticles(storage.positions, storage.velocities, message.count, params);
  }

  self.postMessage({
    id: message.id,
    type: 'validation-cpu-result',
    positions: storage.positions,
    velocities: storage.velocities
  });
};
