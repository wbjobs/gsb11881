export const FIXED_DT = 1 / 60;

export const DEFAULT_PARAMS = Object.freeze({
  gravity: -0.36,
  wind: 0.06,
  attractorStrength: 0.55,
  attractorEnabled: true,
  attractorX: 0,
  attractorY: 0.14
});

export function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(state ^ (state >>> 15), state | 1);
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
    state ^= state >>> 14;
    return (state >>> 0) / 4294967296;
  };
}

export function initializePacked(count, seed = 0x9e3779b9) {
  const data = new Float32Array(count * 4);
  const rng = makeRng(seed);

  for (let i = 0; i < count; i++) {
    const angle = rng() * Math.PI * 2;
    const radius = Math.sqrt(rng()) * 0.62;
    const offset = i * 4;
    data[offset] = Math.cos(angle) * radius;
    data[offset + 1] = Math.sin(angle) * radius * 0.72 + 0.08;
    data[offset + 2] = (rng() - 0.5) * 0.16;
    data[offset + 3] = (rng() - 0.5) * 0.16;
  }

  return data;
}

export function initializePlanar(count, seed = 0x9e3779b9) {
  const packed = initializePacked(count, seed);
  const position = new Float32Array(count * 2);
  const velocity = new Float32Array(count * 2);

  for (let i = 0; i < count; i++) {
    position[i * 2] = packed[i * 4];
    position[i * 2 + 1] = packed[i * 4 + 1];
    velocity[i * 2] = packed[i * 4 + 2];
    velocity[i * 2 + 1] = packed[i * 4 + 3];
  }

  return { position, velocity };
}

export function stepCpuPacked(data, params, dt = FIXED_DT) {
  const attractorEnabled = params.attractorEnabled ? 1 : 0;

  for (let i = 0; i < data.length; i += 4) {
    const x = data[i];
    const y = data[i + 1];
    let vx = data[i + 2];
    let vy = data[i + 3];

    let dx = Math.fround(params.attractorX - x);
    let dy = Math.fround(params.attractorY - y);
    let distanceSquared = Math.fround(
      Math.fround(Math.fround(dx * dx) + Math.fround(dy * dy)) + 0.0025
    );
    const inverseDistance = Math.fround(1 / Math.sqrt(distanceSquared));
    dx = Math.fround(dx * inverseDistance);
    dy = Math.fround(dy * inverseDistance);

    const accelerationX = Math.fround(
      params.wind + Math.fround(attractorEnabled * Math.fround(params.attractorStrength * dx))
    );
    const accelerationY = Math.fround(
      params.gravity + Math.fround(attractorEnabled * Math.fround(params.attractorStrength * dy))
    );

    vx = Math.fround(Math.fround(vx + Math.fround(accelerationX * dt)) * 0.999);
    vy = Math.fround(Math.fround(vy + Math.fround(accelerationY * dt)) * 0.999);

    let nextX = Math.fround(x + Math.fround(vx * dt));
    let nextY = Math.fround(y + Math.fround(vy * dt));

    if (nextX < -1) {
      nextX = -1;
      vx = Math.fround(vx * -0.82);
    } else if (nextX > 1) {
      nextX = 1;
      vx = Math.fround(vx * -0.82);
    }

    if (nextY < -1) {
      nextY = -1;
      vy = Math.fround(vy * -0.82);
    } else if (nextY > 1) {
      nextY = 1;
      vy = Math.fround(vy * -0.82);
    }

    data[i] = nextX;
    data[i + 1] = nextY;
    data[i + 2] = vx;
    data[i + 3] = vy;
  }

  return data;
}

export function stepCpuPlanar(position, velocity, params, dt = FIXED_DT) {
  const count = velocity.length / 2;
  const attractorEnabled = params.attractorEnabled ? 1 : 0;

  for (let i = 0; i < count; i++) {
    const offset = i * 2;
    const x = position[offset];
    const y = position[offset + 1];
    let vx = velocity[offset];
    let vy = velocity[offset + 1];

    let dx = Math.fround(params.attractorX - x);
    let dy = Math.fround(params.attractorY - y);
    const distanceSquared = Math.fround(
      Math.fround(Math.fround(dx * dx) + Math.fround(dy * dy)) + 0.0025
    );
    const inverseDistance = Math.fround(1 / Math.sqrt(distanceSquared));
    dx = Math.fround(dx * inverseDistance);
    dy = Math.fround(dy * inverseDistance);

    vx = Math.fround(Math.fround(vx + Math.fround(Math.fround(
      params.wind + Math.fround(attractorEnabled * Math.fround(params.attractorStrength * dx))
    ) * dt)) * 0.999);
    vy = Math.fround(Math.fround(vy + Math.fround(Math.fround(
      params.gravity + Math.fround(attractorEnabled * Math.fround(params.attractorStrength * dy))
    ) * dt)) * 0.999);

    let nextX = Math.fround(x + Math.fround(vx * dt));
    let nextY = Math.fround(y + Math.fround(vy * dt));

    if (nextX < -1) {
      nextX = -1;
      vx = Math.fround(vx * -0.82);
    } else if (nextX > 1) {
      nextX = 1;
      vx = Math.fround(vx * -0.82);
    }

    if (nextY < -1) {
      nextY = -1;
      vy = Math.fround(vy * -0.82);
    } else if (nextY > 1) {
      nextY = 1;
      vy = Math.fround(vy * -0.82);
    }

    position[offset] = nextX;
    position[offset + 1] = nextY;
    velocity[offset] = vx;
    velocity[offset + 1] = vy;
  }
}
