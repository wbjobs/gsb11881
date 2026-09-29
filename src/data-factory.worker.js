import {
  createParticleStorage,
  initializeParticleRange
} from './physics.js';

self.onmessage = (event) => {
  const message = event.data;

  if (message.type === 'create') {
    const storage = createParticleStorage(
      message.capacity,
      message.bounds,
      message.seed ?? 1337
    );

    self.postMessage(
      {
        type: 'particles-created',
        id: message.id,
        positions: storage.positions,
        velocities: storage.velocities
      },
      [storage.positions.buffer, storage.velocities.buffer]
    );
  }

  if (message.type === 'create-range') {
    const positions = new Float32Array(message.count * 2);
    const velocities = new Float32Array(message.count * 2);
    const start = message.start ?? 0;

    initializeParticleRange(
      positions,
      velocities,
      start,
      start + message.count,
      message.bounds,
      message.seed ?? 1337,
      0
    );

    self.postMessage(
      {
        type: 'range-created',
        id: message.id,
        positions,
        velocities
      },
      [positions.buffer, velocities.buffer]
    );
  }
};
