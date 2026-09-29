export const PARTICLE_COMPONENTS = 2;
export const MAX_PARTICLES = 1_000_000;
export const FIXED_DT = 1 / 60;
export const MAX_ATTRACTORS = 4;

export const DEFAULT_BOUNDS = Object.freeze({
  xMin: -100,
  xMax: 100,
  yMin: -60,
  yMax: 60
});

export const DEFAULT_PARAMS = Object.freeze({
  dt: FIXED_DT,
  gravityX: 0,
  gravityY: -9.8,
  windX: 2,
  windY: 0,
  restitution: 0.72,
  drag: 0.08,
  attractorStrength: 3000,
  bounds: DEFAULT_BOUNDS,
  attractors: [
    { x: -42, y: 22, strength: 3000, enabled: true },
    { x: 42, y: 22, strength: 3000, enabled: true },
    { x: 0, y: -34, strength: 2200, enabled: true },
    { x: 0, y: 0, strength: 0, enabled: false }
  ]
});

export function clampParticles(count) {
  return Math.max(0, Math.min(MAX_PARTICLES, Math.trunc(count)));
}

export function normalizeParams(input = {}) {
  const bounds = { ...DEFAULT_BOUNDS, ...(input.bounds ?? {}) };
  const attractors = Array.from({ length: MAX_ATTRACTORS }, (_, index) => ({
    x: 0,
    y: 0,
    strength: 0,
    enabled: false,
    ...(input.attractors?.[index] ?? DEFAULT_PARAMS.attractors[index] ?? {})
  }));

  return {
    dt: Number.isFinite(input.dt) ? input.dt : FIXED_DT,
    gravityX: input.gravityX ?? DEFAULT_PARAMS.gravityX,
    gravityY: input.gravityY ?? DEFAULT_PARAMS.gravityY,
    windX: input.windX ?? DEFAULT_PARAMS.windX,
    windY: input.windY ?? DEFAULT_PARAMS.windY,
    restitution: input.restitution ?? DEFAULT_PARAMS.restitution,
    drag: input.drag ?? DEFAULT_PARAMS.drag,
    attractorStrength: input.attractorStrength ?? DEFAULT_PARAMS.attractorStrength,
    bounds,
    attractors
  };
}

export function paramsToUniforms(params) {
  const normalized = normalizeParams(params);
  const attractors = new Float32Array(MAX_ATTRACTORS * 4);

  normalized.attractors.forEach((attractor, index) => {
    const offset = index * 4;
    attractors[offset] = attractor.x;
    attractors[offset + 1] = attractor.y;
    attractors[offset + 2] = Number.isFinite(attractor.strength)
      ? attractor.strength
      : normalized.attractorStrength;
    attractors[offset + 3] = attractor.enabled ? 1 : 0;
  });

  return {
    dt: normalized.dt,
    gravity: new Float32Array([normalized.gravityX, normalized.gravityY]),
    wind: new Float32Array([normalized.windX, normalized.windY]),
    boundsMin: new Float32Array([normalized.bounds.xMin, normalized.bounds.yMin]),
    boundsMax: new Float32Array([normalized.bounds.xMax, normalized.bounds.yMax]),
    restitution: normalized.restitution,
    dragFactor: Math.exp(-normalized.drag * normalized.dt),
    attractors
  };
}

export function createParticleStorage(capacity, bounds = DEFAULT_BOUNDS, seed = 1337) {
  const positions = new Float32Array(capacity * PARTICLE_COMPONENTS);
  const velocities = new Float32Array(capacity * PARTICLE_COMPONENTS);
  initializeParticleRange(positions, velocities, 0, capacity, bounds, seed);
  return { positions, velocities };
}

export function initializeParticleRange(
  positions,
  velocities,
  start,
  end,
  bounds = DEFAULT_BOUNDS,
  seed = 1337,
  destinationStart = start
) {
  const width = bounds.xMax - bounds.xMin;
  const height = bounds.yMax - bounds.yMin;

  for (let index = start; index < end; index++) {
    let state = (seed ^ Math.imul(index + 1, 2654435761)) >>> 0;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };

    const destinationIndex = destinationStart + (index - start);
    positions[destinationIndex * 2] = bounds.xMin + (0.12 + random() * 0.76) * width;
    positions[destinationIndex * 2 + 1] = bounds.yMin + (0.16 + random() * 0.68) * height;
    velocities[destinationIndex * 2] = (random() - 0.5) * 8;
    velocities[destinationIndex * 2 + 1] = (random() - 0.5) * 8;
  }
}

export function clearParticleRange(positions, velocities, start, end) {
  positions.fill(0, start * 2, end * 2);
  velocities.fill(0, start * 2, end * 2);
}

export function resizeActiveParticles(positions, velocities, previousCount, nextCount, bounds, seed = 1337) {
  if (nextCount > previousCount) {
    initializeParticleRange(positions, velocities, previousCount, nextCount, bounds, seed);
  } else if (nextCount < previousCount) {
    clearParticleRange(positions, velocities, nextCount, previousCount);
  }
}

export function stepParticles(positions, velocities, count, rawParams) {
  const params = normalizeParams(rawParams);
  const dt = params.dt;
  const dragFactor = Math.exp(-params.drag * dt);
  const { xMin, xMax, yMin, yMax } = params.bounds;

  for (let index = 0; index < count; index++) {
    const offset = index * 2;
    let positionX = positions[offset];
    let positionY = positions[offset + 1];
    let velocityX = velocities[offset];
    let velocityY = velocities[offset + 1];

    let accelerationX = params.gravityX + params.windX;
    let accelerationY = params.gravityY + params.windY;

    for (let attractorIndex = 0; attractorIndex < MAX_ATTRACTORS; attractorIndex++) {
      const attractor = params.attractors[attractorIndex];
      if (!attractor?.enabled) continue;

      const deltaX = attractor.x - positionX;
      const deltaY = attractor.y - positionY;
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
      const strength = Number.isFinite(attractor.strength)
        ? attractor.strength
        : params.attractorStrength;
      const force = strength / ((distance + 0.001) * (distance * distance + 100));
      accelerationX += deltaX * force;
      accelerationY += deltaY * force;
    }

    velocityX = (velocityX + accelerationX * dt) * dragFactor;
    velocityY = (velocityY + accelerationY * dt) * dragFactor;
    positionX += velocityX * dt;
    positionY += velocityY * dt;

    if (positionX < xMin) {
      positionX = xMin;
      if (velocityX < 0) velocityX = -velocityX * params.restitution;
    } else if (positionX > xMax) {
      positionX = xMax;
      if (velocityX > 0) velocityX = -velocityX * params.restitution;
    }

    if (positionY < yMin) {
      positionY = yMin;
      if (velocityY < 0) velocityY = -velocityY * params.restitution;
    } else if (positionY > yMax) {
      positionY = yMax;
      if (velocityY > 0) velocityY = -velocityY * params.restitution;
    }

    positions[offset] = positionX;
    positions[offset + 1] = positionY;
    velocities[offset] = velocityX;
    velocities[offset + 1] = velocityY;
  }
}

export function checksumParticles(positions, velocities, count) {
  let positionSum = 0;
  let velocitySum = 0;

  for (let index = 0; index < count * 2; index++) {
    positionSum += positions[index] * (index % 7 + 1);
    velocitySum += velocities[index] * (index % 5 + 1);
  }

  return { positionSum, velocitySum };
}
