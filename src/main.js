import { DEFAULT_PARAMS, FIXED_DT } from './physics.js';
import { createParticleSystem, formatBytes } from './particle-system.js';
import { formatMilliseconds, PerformanceMonitor } from './perf-monitor.js';

const canvas = document.querySelector('#stage');
const controls = Object.fromEntries(
  Array.from(document.querySelectorAll('[id]')).map((element) => [element.id, element])
);

const url = new URL(globalThis.location.href);
const config = {
  backend: url.searchParams.get('backend') ?? 'auto',
  forceOom: url.searchParams.get('forceOom') === '1',
  disableTf: url.searchParams.get('disableTf') === '1',
  vramBudget: parseMemory(url.searchParams.get('vramBudget')) ?? 42 * 1024 * 1024
};

controls.backend.value = ['auto', 'tf', 'texture', 'cpu'].includes(config.backend)
  ? config.backend
  : 'auto';

const state = {
  requestedCount: Number(controls.count.value),
  activeCount: 0,
  capacity: 0,
  kind: 'unknown',
  paused: false,
  params: { ...DEFAULT_PARAMS },
  latestSnapshot: null,
  worker: null,
  system: null,
  initialPromise: null,
  reinitializing: false,
  contextLost: false,
  backendMemory: 0,
  lastSteps: 1
};

const monitor = new PerformanceMonitor();

syncParameterControls();
bindControls();
bindCanvasPointer();
bindContextLoss();
initializeSystem().catch((error) => {
  showWarning(`初始化失败：${error.message}`);
});

let lastFrameTime = performance.now();
let accumulator = 0;

function bindControls() {
  controls.pause.addEventListener('click', () => {
    state.paused = !state.paused;
    controls.pause.textContent = state.paused ? '继续' : '暂停';
    if (state.kind === 'cpu' && state.worker) {
      state.worker.postMessage({ type: state.paused ? 'pause' : 'start' });
    }
  });

  controls.reset.addEventListener('click', () => initializeSystem());
  controls.backend.addEventListener('change', () => initializeSystem(controls.backend.value));
  controls.count.addEventListener('change', () => {
    state.requestedCount = Number(controls.count.value);
    initializeSystem();
  });

  for (const key of ['gravity', 'wind', 'attractorStrength', 'attractorEnabled']) {
    controls[key].addEventListener('input', () => {
      readParameterControls();
      sendParams();
    });
  }

  controls.verify.addEventListener('click', () => verifyConsistency());
  controls.benchmark.addEventListener('click', () => runComparisonBenchmark());
}

function bindCanvasPointer() {
  let dragging = false;

  const updateAttractor = (event) => {
    const rect = canvas.getBoundingClientRect();
    state.params.attractorX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    state.params.attractorY = 1 - ((event.clientY - rect.top) / rect.height) * 2;
    sendParams();
  };

  canvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    canvas.setPointerCapture(event.pointerId);
    updateAttractor(event);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (dragging) updateAttractor(event);
  });
  canvas.addEventListener('pointerup', () => {
    dragging = false;
  });
}

function bindContextLoss() {
  canvas.addEventListener('webglcontextlost', (event) => {
    if (!state.system?.gl) return;
    event.preventDefault();
    state.contextLost = true;
    showWarning('WebGL 上下文丢失，通常由显存压力触发。恢复后将自动重建。');
  });

  canvas.addEventListener('webglcontextrestored', () => {
    state.contextLost = false;
    initializeSystem();
  });
}

function readParameterControls() {
  state.params.gravity = Number(controls.gravity.value);
  state.params.wind = Number(controls.wind.value);
  state.params.attractorStrength = Number(controls.attractorStrength.value);
  state.params.attractorEnabled = controls.attractorEnabled.checked;
  syncParameterLabels();
}

function syncParameterControls() {
  controls.gravity.value = state.params.gravity;
  controls.wind.value = state.params.wind;
  controls.attractorStrength.value = state.params.attractorStrength;
  controls.attractorEnabled.checked = state.params.attractorEnabled;
  syncParameterLabels();
}

function syncParameterLabels() {
  controls.gravityValue.textContent = Number(state.params.gravity).toFixed(2);
  controls.windValue.textContent = Number(state.params.wind).toFixed(2);
  controls.attractorValue.textContent = Number(state.params.attractorStrength).toFixed(2);
}

function sendParams() {
  if (state.worker && state.kind === 'cpu') {
    state.worker.postMessage({ type: 'params', params: state.params });
  }
}

async function initializeSystem(preferredBackend = controls.backend.value) {
  if (state.reinitializing) return;
  state.reinitializing = true;
  setBusy(true);
  controls.benchmarkResult.textContent = '';

  try {
    destroyCurrentSystem();
    resizeCanvas();

    const system = createParticleSystem(canvas, {
      backend: preferredBackend,
      forceOom: config.forceOom,
      disableTf: config.disableTf,
      vramBudget: config.vramBudget
    });

    const initialWorker = createWorker();
    const initial = await requestState(
      initialWorker,
      state.requestedCount,
      0x9e3779b9,
      'initial-gpu'
    );
    initialWorker.terminate();

    const allocation = system.allocate(
      state.requestedCount,
      initial,
      state.requestedCount
    );

    state.system = system;
    state.kind = system.kind;
    state.capacity = allocation.capacity;
    state.activeCount = allocation.activeCount;
    state.backendMemory = system.kind === 'cpu'
      ? state.capacity * 16 * (system.is2d ? 5 : 2)
      : system.kind === 'tf'
        ? state.capacity * 32
        : estimateTextureMemoryLocal(state.capacity);

    resizeBackend();
    renderMode(system.warnings);

    if (system.kind === 'cpu') {
      startCpuWorker(state.requestedCount);
    }

    if (!state.paused) controls.pause.textContent = '暂停';
  } catch (error) {
    showWarning(error.message);
  } finally {
    state.reinitializing = false;
    setBusy(false);
  }
}

function startCpuWorker(count) {
  const worker = createWorker();
  state.worker = worker;

  worker.onmessage = (event) => {
    const message = event.data;

    if (message.type === 'snapshot') {
      if (state.latestSnapshot) {
        state.worker.postMessage({ type: 'recycle', buffer: state.latestSnapshot.buffer });
      }

      state.latestSnapshot = message;
      if (Number.isFinite(message.stepMs)) monitor.setWorker(message.stepMs);
      state.lastSteps = message.steps ?? 1;
    }
  };

  worker.postMessage({
    type: 'init',
    count,
    seed: 0x9e3779b9,
    live: true,
    params: state.params
  });

  if (state.paused) worker.postMessage({ type: 'pause' });
}

function createWorker() {
  return new Worker(new URL('./sim-worker.js', import.meta.url), {
    type: 'module'
  });
}

function requestState(worker, count, seed, kind) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('初始化粒子数据超时')), 30000);

    worker.onmessage = (event) => {
      if (event.data.type === 'state') {
        clearTimeout(timer);
        resolve(new Float32Array(event.data.buffer));
      }
    };
    worker.onerror = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    worker.postMessage({ type: 'generate-state', count, seed, kind });
  });
}

function destroyCurrentSystem() {
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }

  if (state.latestSnapshot) {
    state.latestSnapshot = null;
  }

  if (state.system) {
    try {
      state.system.dispose();
    } catch {
      // 上下文丢失时 WebGL 资源可能已被驱动释放。
    }
    state.system = null;
  }

  state.kind = 'unknown';
  state.latestSnapshot = null;
}

function frame(now) {
  requestAnimationFrame(frame);
  if (!state.system || state.contextLost) return;

  monitor.beginFrame();
  const frameSeconds = Math.min(0.05, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  if (!state.paused && state.kind !== 'cpu') {
    accumulator += frameSeconds;
    let steps = Math.floor(accumulator / FIXED_DT);
    steps = Math.min(3, Math.max(0, steps));

    if (steps > 0) {
      monitor.beginUpdate();
      for (let i = 0; i < steps; i++) state.system.backend.update(state.params, FIXED_DT);
      monitor.endUpdate();
      accumulator -= steps * FIXED_DT;
      state.lastSteps = steps;
      if (state.system.backend.gpuSeconds) {
        monitor.setGpu(state.system.backend.gpuSeconds);
      }
    } else {
      accumulator = 0;
    }
  }

  prepareFrame();
  const renderBeganAt = performance.now();

  if (state.kind === 'cpu') {
    renderCpuSnapshot();
  } else {
    state.system.backend.render(canvas.clientWidth, canvas.clientHeight);
  }

  monitor.endFrame(renderBeganAt);
  updateStats();
}

function prepareFrame() {
  resizeCanvas();
  resizeBackend();

  if (!state.system.gl) return;

  const { gl } = state.system;
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0.012, 0.018, 0.035, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
}

function renderCpuSnapshot() {
  const snapshot = state.latestSnapshot;
  if (!snapshot) return;
  state.system.backend.upload(snapshot.buffer, snapshot.count);
  state.system.backend.render();
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  canvas.dpr = dpr;
}

function resizeBackend() {
  if (!state.system) return;
  state.system.backend.resize(
    canvas.width,
    canvas.height,
    Math.min(window.devicePixelRatio || 1, 1.5)
  );
}

requestAnimationFrame(frame);

function renderMode(warnings = []) {
  const labels = {
    tf: 'GPU · WebGL2 Transform Feedback',
    texture: 'GPU · WebGL 浮点纹理计算',
    cpu: state.system?.is2d
      ? 'CPU Worker · Canvas2D 抽样渲染'
      : 'CPU Worker · WebGL 点渲染'
  };
  controls.mode.textContent = labels[state.kind] ?? state.kind;

  if (warnings.length > 0) showWarning(warnings.join(' '));
  else controls.warnings.hidden = true;
}

function showWarning(message) {
  controls.warnings.hidden = false;
  controls.warnings.textContent = message;
}

function setBusy(busy) {
  for (const id of ['pause', 'reset', 'verify', 'benchmark', 'backend', 'count']) {
    controls[id].disabled = busy;
  }
}

function updateStats() {
  const metrics = monitor.snapshot();
  const particlesPerSecond = state.activeCount * metrics.fps * state.lastSteps / 1e9;

  controls.stats.innerHTML = [
    ['FPS', metrics.fps ? metrics.fps.toFixed(1) : '—'],
    ['激活/请求', `${formatNumber(state.activeCount)} / ${formatNumber(state.requestedCount)}`],
    ['缓冲容量', formatNumber(state.capacity)],
    ['显存/缓冲', formatBytes(state.backendMemory)],
    ['主线程帧', formatMilliseconds(metrics.frameMs)],
    ['物理更新', state.kind === 'cpu' ? 'Worker' : formatMilliseconds(metrics.updateMs)],
    ['GPU 查询', formatMilliseconds(metrics.gpuMs)],
    ['Worker 步', formatMilliseconds(metrics.workerMs)],
    ['渲染', formatMilliseconds(metrics.renderMs)],
    ['长任务', `${metrics.longTasks} 次 / ${metrics.longTaskMs.toFixed(0)}ms`],
    ['峰值长任务', formatMilliseconds(metrics.maxLongTaskMs)],
    ['吞吐', `${particlesPerSecond.toFixed(1)}G 步粒子/s`]
  ].map(([key, value]) => `<span>${key}</span><b>${value}</b>`).join('');
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('zh-CN');
}

function parseMemory(value) {
  if (!value) return null;
  const match = /^(\d+(?:\.\d+)?)(m|g)?$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const multiplier = match[2]?.toLowerCase() === 'g' ? 1024 ** 3 : 1024 ** 2;
  return amount * multiplier;
}

function estimateTextureMemoryLocal(count) {
  const size = 1 << Math.ceil(Math.log2(Math.max(1, Math.ceil(Math.sqrt(count)))));
  return size * size * 4 * 4 * 2;
}

async function runComparisonBenchmark() {
  if (!state.system || state.reinitializing) return;
  const wasPaused = state.paused;
  state.paused = true;
  setBusy(true);
  controls.benchmarkResult.textContent = '准备 100 万粒子、300 个固定步…';

  const count = state.activeCount;
  const steps = 300;
  const chunkSize = 25;
  const seed = 0x1234abcd;

  try {
    const cpu = await benchmarkCpu(count, steps, seed);
    const gpu = state.kind === 'cpu'
      ? null
      : await benchmarkCurrentGpu(count, steps, chunkSize, seed);

    renderBenchmarkResult(cpu, gpu, count, steps);
  } catch (error) {
    controls.benchmarkResult.textContent = `基准失败：${error.message}`;
  } finally {
    state.paused = wasPaused;
    controls.pause.textContent = state.paused ? '继续' : '暂停';
    setBusy(false);
  }
}

function benchmarkCpu(count, steps, seed) {
  return new Promise((resolve, reject) => {
    const worker = createWorker();
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('CPU 基准超时'));
    }, 120000);

    worker.onmessage = (event) => {
      if (event.data.type === 'benchmark-result') {
        clearTimeout(timer);
        worker.terminate();
        resolve(event.data);
      }
    };

    worker.onerror = (error) => {
      clearTimeout(timer);
      worker.terminate();
      reject(error);
    };

    worker.postMessage({
      type: 'benchmark',
      count,
      steps,
      seed,
      params: state.params
    });
  });
}

async function benchmarkCurrentGpu(count, steps, chunkSize, seed) {
  const worker = createWorker();

  try {
    const initial = await requestState(worker, count, seed, 'benchmark-gpu');
    const backend = state.system.backend;
    backend.allocate(count, initial, count);
    state.activeCount = count;
    state.capacity = count;
    state.backendMemory = state.kind === 'tf' ? count * 32 : estimateTextureMemoryLocal(count);
    state.system.gl.finish();

    const began = performance.now();
    for (let completed = 0; completed < steps; completed += chunkSize) {
      const currentChunk = Math.min(chunkSize, steps - completed);
      for (let i = 0; i < currentChunk; i++) {
        backend.update(state.params, FIXED_DT);
      }
      state.system.gl.finish();
      controls.benchmarkResult.textContent =
        `GPU 基准进行中：${Math.min(steps, completed + chunkSize)} / ${steps} 步`;
      await yieldToUi();
    }
    const elapsed = (performance.now() - began) / 1000;

    backend.reset(initial);
    state.system.gl.finish();

    return {
      elapsed,
      particlesPerSecond: (count * steps) / elapsed,
      gpuSeconds: backend.gpuSeconds,
      steps,
      count
    };
  } finally {
    worker.terminate();
  }
}

function renderBenchmarkResult(cpu, gpu, count, steps) {
  const lines = [
    `${formatNumber(count)} 粒子 × ${steps} 固定步`,
    `CPU Worker：${cpu.elapsed.toFixed(3)}s，${billion(cpu.particlesPerSecond)}/s`,
    gpu
      ? `GPU ${state.kind}：${gpu.elapsed.toFixed(3)}s，${billion(gpu.particlesPerSecond)}/s`
      : 'GPU：当前已处于 CPU 降级，无 GPU 计时',
    gpu ? `实测加速比：${(cpu.elapsed / gpu.elapsed).toFixed(2)}×` : '加速比：—'
  ];

  controls.benchmarkResult.textContent = lines.join('\n');
}

async function verifyConsistency() {
  if (!state.system || state.reinitializing) return;
  setBusy(true);
  controls.benchmarkResult.textContent = '正在用确定性数据校验 CPU/GPU 公式…';

  const count = 4096;
  const steps = 60;
  const seed = 0xc0ffee;
  const worker = createWorker();

  try {
    const reference = await consistencyReference(worker, count, steps, seed);

    if (state.kind === 'cpu') {
      controls.benchmarkResult.textContent =
        '当前是 CPU 降级路径；已验证 Worker 使用确定性参考实现。可切换 GPU 后端做交叉校验。';
      return;
    }

    const gpuFinal = await state.system.backend.trial(
      reference.initial,
      steps,
      state.params,
      FIXED_DT
    );
    const result = compareState(reference.cpuFinal, gpuFinal);
    controls.benchmarkResult.textContent =
      `CPU/GPU 一致性通过\n${formatNumber(count)} 粒子 × ${steps} 步\n` +
      `平均误差 ${result.mean.toExponential(2)}，最大误差 ${result.max.toExponential(2)}`;
  } catch (error) {
    controls.benchmarkResult.textContent = `一致性校验失败：${error.message}`;
  } finally {
    worker.terminate();
    setBusy(false);
  }
}

function consistencyReference(worker, count, steps, seed) {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event) => {
      if (event.data.type !== 'consistency-result') return;
      resolve({
        initial: new Float32Array(event.data.initial),
        cpuFinal: new Float32Array(event.data.cpuFinal)
      });
    };
    worker.onerror = reject;
    worker.postMessage({
      type: 'consistency',
      count,
      steps,
      seed,
      params: state.params
    });
  });
}

function compareState(expected, actual) {
  let sum = 0;
  let max = 0;

  for (let i = 0; i < expected.length; i++) {
    const delta = Math.abs(expected[i] - actual[i]);
    sum += delta;
    max = Math.max(max, delta);
  }

  const mean = sum / expected.length;
  if (mean > 0.02 || max > 0.12) {
    throw new Error(`误差超阈值：平均 ${mean}，最大 ${max}`);
  }

  return { mean, max };
}

function billion(value) {
  return `${(value / 1e9).toFixed(2)}G 步粒子`;
}

function yieldToUi() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
