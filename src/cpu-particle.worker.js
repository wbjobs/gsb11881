import {
  createParticleStorage,
  normalizeParams,
  resizeActiveParticles,
  stepParticles
} from './physics.js';
import { createCpuRenderer } from './cpu-renderer.js';

const state = {
  capacity: 0,
  activeCount: 0,
  positions: null,
  velocities: null,
  params: normalizeParams(),
  renderer: null,
  rendererType: 'headless',
  canvas: null,
  pointSize: 1,
  running: false,
  rafId: 0,
  frameCount: 0,
  lastStatsAt: 0,
  fpsTime: 0,
  fpsFrames: 0,
  physicsSum: 0,
  renderSum: 0,
  sampleCount: 0
};

function post(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

function init(message) {
  state.capacity = message.capacity;
  state.activeCount = message.activeCount ?? message.capacity;
  state.params = normalizeParams(message.params);
  state.canvas = message.canvas ?? null;

  try {
    const storage = createParticleStorage(state.capacity, state.params.bounds, message.seed ?? 1337);
    state.positions = storage.positions;
    state.velocities = storage.velocities;

    if (state.canvas) {
      const result = createCpuRenderer(state.canvas, message.preferWebGL !== false);
      state.rendererType = result.type;
      state.renderer = result.renderer;
    }

    post('cpu-ready', {
      capacity: state.capacity,
      activeCount: state.activeCount,
      rendererType: state.rendererType
    });
  } catch (error) {
    post('cpu-error', {
      reason: 'cpu-memory',
      message: error.message,
      capacity: state.capacity
    });
  }
}

function reset(message) {
  const storage = createParticleStorage(message.capacity ?? state.capacity, message.bounds ?? state.params.bounds, message.seed ?? 1337);
  state.capacity = storage.positions.length / 2;
  state.activeCount = message.activeCount ?? state.capacity;
  state.positions = storage.positions;
  state.velocities = storage.velocities;
  post('cpu-reset', { capacity: state.capacity, activeCount: state.activeCount });
}

function setActiveCount(nextCount) {
  const previous = state.activeCount;
  resizeActiveParticles(state.positions, state.velocities, previous, nextCount, state.params.bounds);
  state.activeCount = nextCount;
  post('cpu-count', { activeCount: state.activeCount });
}

function postStats(now) {
  const elapsed = now - state.lastStatsAt;
  if (elapsed <= 0) return;

  post('cpu-stats', {
    fps: state.fpsFrames * 1000 / elapsed,
    physicsMs: state.physicsSum / Math.max(1, state.sampleCount),
    renderMs: state.renderSum / Math.max(1, state.sampleCount),
    activeCount: state.activeCount,
    rendererType: state.rendererType
  });

  state.lastStatsAt = now;
  state.fpsFrames = 0;
  state.physicsSum = 0;
  state.renderSum = 0;
  state.sampleCount = 0;
}

function frame(now) {
  if (!state.running) return;

  const physicsStart = performance.now();
  stepParticles(state.positions, state.velocities, state.activeCount, state.params);
  const physicsMs = performance.now() - physicsStart;

  let renderMs = 0;
  if (state.renderer) {
    const renderStart = performance.now();
    if (state.rendererType === '2d') {
      state.renderer.render(
        state.positions, state.velocities, state.activeCount, state.params,
        state.canvas.width, state.canvas.height
      );
    } else {
      state.renderer.render(
        state.positions,
        state.velocities,
        state.activeCount,
        state.params,
        state.pointSize
      );
    }
    renderMs = performance.now() - renderStart;
  }

  state.frameCount += 1;
  state.fpsFrames += 1;
  state.physicsSum += physicsMs;
  state.renderSum += renderMs;
  state.sampleCount += 1;

  if (!state.lastStatsAt) state.lastStatsAt = now;
  if (now - state.lastStatsAt >= 500) postStats(now);
  state.rafId = requestAnimationFrame(frame);
}

self.onmessage = (event) => {
  const message = event.data;

  switch (message.type) {
    case 'init':
      init(message);
      break;
    case 'start':
      if (!state.running && state.canvas) {
        state.running = true;
        state.lastStatsAt = 0;
        state.rafId = requestAnimationFrame(frame);
      }
      break;
    case 'pause':
      state.running = false;
      if (state.rafId) cancelAnimationFrame(state.rafId);
      break;
    case 'step-once':
      stepParticles(state.positions, state.velocities, state.activeCount, state.params);
      if (state.renderer) {
        state.renderer.render(
          state.positions,
          state.velocities,
          state.activeCount,
          state.params,
          state.pointSize
        );
      }
      break;
    case 'set-params':
      state.params = normalizeParams(message.params);
      break;
    case 'set-count':
      setActiveCount(message.activeCount);
      break;
    case 'add-particles': {
      const endIndex = message.startIndex + message.positions.length / 2;
      state.positions.set(message.positions, message.startIndex * 2);
      state.velocities.set(message.velocities, message.startIndex * 2);
      state.activeCount = Math.max(state.activeCount, endIndex);
      post('cpu-count', { activeCount: state.activeCount });
      break;
    }
    case 'set-point-size':
      state.pointSize = message.pointSize;
      break;
    case 'reset':
      reset(message);
      break;
    case 'read-particles':
      post('particles', {
        positions: state.positions.slice(0, state.activeCount * 2),
        velocities: state.velocities.slice(0, state.activeCount * 2)
      });
      break;
  }
};
