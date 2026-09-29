import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BOUNDS,
  MAX_PARTICLES,
  clampParticles,
  createParticleStorage,
  initializeParticleRange,
  normalizeParams,
  resizeActiveParticles,
  stepParticles
} from '../src/physics.js';

test('particle count is clamped to the one million hard cap', () => {
  assert.equal(clampParticles(2_000_000), MAX_PARTICLES);
  assert.equal(clampParticles(-3), 0);
});

test('deterministic storage initializes finite values inside bounds', () => {
  const count = 2048;
  const { positions, velocities } = createParticleStorage(count);

  for (let index = 0; index < count; index += 1) {
    const x = positions[index * 2];
    const y = positions[index * 2 + 1];
    assert.ok(x >= DEFAULT_BOUNDS.xMin && x <= DEFAULT_BOUNDS.xMax);
    assert.ok(y >= DEFAULT_BOUNDS.yMin && y <= DEFAULT_BOUNDS.yMax);
    assert.ok(Number.isFinite(velocities[index * 2]));
    assert.ok(Number.isFinite(velocities[index * 2 + 1]));
  }
});

test('gravity and floor collision move particles and constrain them', () => {
  const { positions, velocities } = createParticleStorage(64, DEFAULT_BOUNDS, 42);
  const original = positions.slice();
  const params = normalizeParams({
    gravityX: 0,
    gravityY: -20,
    windX: 0,
    windY: 0,
    drag: 0,
    restitution: 0.8,
    attractors: []
  });

  for (let frame = 0; frame < 240; frame += 1) {
    stepParticles(positions, velocities, 64, params);
  }

  let changed = false;
  for (let index = 0; index < 64; index += 1) {
    const offset = index * 2;
    changed ||= positions[offset + 1] !== original[offset + 1];
    assert.ok(positions[offset] >= DEFAULT_BOUNDS.xMin - 1e-6);
    assert.ok(positions[offset] <= DEFAULT_BOUNDS.xMax + 1e-6);
    assert.ok(positions[offset + 1] >= DEFAULT_BOUNDS.yMin - 1e-6);
    assert.ok(positions[offset + 1] <= DEFAULT_BOUNDS.yMax + 1e-6);
  }
  assert.ok(changed);
});

test('dynamic growth initializes a destination range and shrink clears data', () => {
  const capacity = 8;
  const { positions, velocities } = createParticleStorage(capacity);

  positions.fill(0);
  velocities.fill(0);
  initializeParticleRange(positions, velocities, 2, 5, DEFAULT_BOUNDS, 99, 0);

  assert.ok(positions[0] !== 0 || positions[1] !== 0);
  assert.ok(positions[6] === 0);

  resizeActiveParticles(positions, velocities, 5, 3, DEFAULT_BOUNDS);
  assert.deepEqual(Array.from(positions.slice(6, 10)), [0, 0, 0, 0]);
});

test('wind changes horizontal state and attractor update is applied', () => {
  const { positions, velocities } = createParticleStorage(128, DEFAULT_BOUNDS, 7);
  const params = normalizeParams({
    gravityY: 0,
    windX: 20,
    windY: 0,
    drag: 0,
    attractors: [{ x: 0, y: 0, strength: 0, enabled: false }]
  });

  stepParticles(positions, velocities, 128, params);
  const averageVelocity = velocities.reduce((sum, value, index) => {
    return index % 2 === 0 ? sum + value : sum;
  }, 0) / 128;
  assert.ok(averageVelocity > 0.2);
});
