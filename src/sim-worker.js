import { DEFAULT_PARAMS, FIXED_DT, initializePacked, stepCpuPacked } from './physics.js';

let count = 0;
let seed = 0x9e3779b9;
let state = null;
let params = { ...DEFAULT_PARAMS };
let running = false;
let pool = [];
let loopToken = 0;
let lastTime = 0;
let lastStepMs = null;
const SNAPSHOT_POOL_SIZE = 4;

self.onmessage = (event) => {
  const message = event.data;

  switch (message.type) {
    case 'init':
      init(message);
      break;
    case 'start':
      start();
      break;
    case 'pause':
      running = false;
      break;
    case 'params':
      params = { ...params, ...message.params };
      break;
    case 'recycle':
      if (message.buffer instanceof ArrayBuffer) pool.push(message.buffer);
      break;
    case 'reset':
      resetState(message.count ?? count, message.seed ?? seed);
      break;
    case 'generate-state':
      generateState(message);
      break;
    case 'consistency':
      consistencyCheck(message);
      break;
    case 'benchmark':
      benchmark(message);
      break;
    case 'close':
      running = false;
      self.close();
      break;
  }
};

function init(message) {
  count = message.count;
  seed = message.seed ?? seed;
  if (message.params) params = { ...params, ...message.params };
  state = initializePacked(count, seed);

  if (message.live) {
    pool = Array.from({ length: SNAPSHOT_POOL_SIZE }, () => new ArrayBuffer(count * 16));
    postSnapshot('initial');
    start();
  } else {
    const buffer = state.slice().buffer;
    self.postMessage({ type: 'state', kind: 'initial', count, buffer }, [buffer]);
  }
}

function resetState(nextCount = count, nextSeed = seed) {
  running = false;
  loopToken++;
  count = nextCount;
  seed = nextSeed;
  state = initializePacked(count, seed);
  pool = Array.from({ length: SNAPSHOT_POOL_SIZE }, () => new ArrayBuffer(count * 16));
  postSnapshot('initial');
  start();
}

function start() {
  if (running) return;
  running = true;
  const token = ++loopToken;
  lastTime = performance.now();
  queueStep(token);
}

function queueStep(token) {
  setTimeout(() => {
    if (!running || token !== loopToken) return;
    const now = performance.now();
    let frameTime = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;
    let steps = Math.floor(frameTime / FIXED_DT);
    steps = Math.max(1, Math.min(3, steps || 1));

    const began = performance.now();
    for (let i = 0; i < steps; i++) {
      stepCpuPacked(state, params, FIXED_DT);
    }
    lastStepMs = performance.now() - began;

    postSnapshot('snapshot', { steps, stepMs: lastStepMs });
    queueStep(token);
  }, 0);
}

function postSnapshot(kind, extra = {}) {
  const buffer = pool.pop();
  if (!buffer) return false;
  new Float32Array(buffer).set(state);
  self.postMessage(
    {
      type: 'snapshot',
      kind,
      count,
      buffer,
      params: { ...params },
      ...extra
    },
    [buffer]
  );
  return true;
}

function benchmark(message) {
  const benchmarkCount = message.count;
  const benchmarkSteps = message.steps ?? 300;
  const data = initializePacked(benchmarkCount, message.seed ?? seed);
  const benchmarkParams = { ...DEFAULT_PARAMS, ...(message.params ?? {}) };

  const began = performance.now();
  for (let i = 0; i < benchmarkSteps; i++) {
    stepCpuPacked(data, benchmarkParams, FIXED_DT);
  }
  const elapsed = (performance.now() - began) / 1000;

  self.postMessage({
    type: 'benchmark-result',
    backend: 'cpu',
    count: benchmarkCount,
    steps: benchmarkSteps,
    elapsed,
    particlesPerSecond: (benchmarkCount * benchmarkSteps) / elapsed,
    finalChecksum: checksum(data)
  });
}

function generateState(message) {
  const generatedCount = message.count ?? count;
  const generated = initializePacked(generatedCount, message.seed ?? seed);
  const buffer = generated.buffer;
  self.postMessage(
    { type: 'state', kind: message.kind ?? 'generated', count: generatedCount, buffer },
    [buffer]
  );
}

function consistencyCheck(message) {
  const testCount = message.count ?? 2048;
  const testSteps = message.steps ?? 48;
  const testParams = { ...DEFAULT_PARAMS, ...(message.params ?? {}) };
  const initial = initializePacked(testCount, message.seed ?? seed);
  const finalState = new Float32Array(initial);

  for (let i = 0; i < testSteps; i++) {
    stepCpuPacked(finalState, testParams, FIXED_DT);
  }

  self.postMessage(
    {
      type: 'consistency-result',
      count: testCount,
      steps: testSteps,
      initial: initial.buffer,
      cpuFinal: finalState.buffer
    },
    [initial.buffer, finalState.buffer]
  );
}

function checksum(data) {
  let total = 0;
  const stride = Math.max(1, Math.floor(data.length / 4096));
  for (let i = 0; i < data.length; i += stride) {
    total += data[i];
  }
  return total;
}
