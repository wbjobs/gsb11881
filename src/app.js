import {
  DEFAULT_PARAMS,
  MAX_PARTICLES,
  clampParticles,
  normalizeParams
} from './physics.js';
import { GpuParticleSystem } from './gpu-particles.js';
import { detectGpuSupport } from './gpu-support.js';
import { GpuCapabilityError, GpuMemoryError, ParticleOverflowError } from './errors.js';
import { WorkerClient } from './worker-client.js';
import { PerformanceMonitor } from './performance-monitor.js';
import { createParticleData, compareBenchmarks, runCpuBenchmark, runGpuBenchmark } from './benchmark.js';
import { validateCpuGpuConsistency } from './validation.js';
import { MainThreadCpuRunner } from './main-cpu-runner.js';

const $ = (id) => document.getElementById(id);
let canvas = $('particleCanvas');
const overlay = $('overlayCanvas');
const overlayContext = overlay.getContext('2d');

const elements = {
  loading: $('loading'),
  backendStatus: $('backendStatus'),
  backendBadge: $('backendBadge'),
  memoryBadge: $('memoryBadge'),
  resultBox: $('resultBox'),
  count: $('particleCount'),
  countLabel: $('countLabel'),
  gravityY: $('gravityY'),
  windX: $('windX'),
  attractorStrength: $('attractorStrength'),
  drag: $('drag'),
  restitution: $('restitution'),
  pointSize: $('pointSize'),
  gravityValue: $('gravityValue'),
  windValue: $('windValue'),
  strengthValue: $('strengthValue'),
  dragValue: $('dragValue'),
  restitutionValue: $('restitutionValue'),
  pointSizeValue: $('pointSizeValue'),
  toggleRun: $('toggleRun'),
  fps: $('fpsValue'),
  physics: $('physicsValue'),
  gpuTime: $('gpuTimeValue'),
  longTask: $('longTaskValue'),
  throughput: $('throughputValue'),
  bufferMemory: $('bufferMemoryValue'),
  benchmarkPanel: $('benchmarkPanel'),
  benchmarkResult: $('benchmarkResult')
};

const state = {
  mode: 'gpu',
  capacity: MAX_PARTICLES,
  activeCount: MAX_PARTICLES,
  params: normalizeParams(DEFAULT_PARAMS),
  running: true,
  gpu: null,
  cpu: null,
  initialData: null,
  fallbackReasons: [],
  frameHandle: 0,
  lastFrameAt: 0,
  frameSamples: [],
  cpuStats: null,
  longTaskBaseline: performance.now(),
  statsStartedAt: performance.now(),
  draggingAttractor: -1
};

const monitor = new PerformanceMonitor();
monitor.start();

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function formatMebibytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function setResult(message) {
  elements.resultBox.textContent = message;
}

function setBackend(mode, reason = '') {
  state.mode = mode;
  const label = mode === 'gpu' ? 'GPU TF' : mode === 'cpu' ? 'CPU Worker' : 'CPU 主线程';
  elements.backendBadge.textContent = `${label}${reason ? ` · ${reason}` : ''}`;
  elements.backendBadge.className = `badge${mode === 'gpu' ? ' ok' : ' warn'}`;
}

function readControlParams() {
  const attractorStrength = Number(elements.attractorStrength.value);
  return {
    ...state.params,
    gravityY: Number(elements.gravityY.value),
    windX: Number(elements.windX.value),
    attractorStrength,
    drag: Number(elements.drag.value),
    restitution: Number(elements.restitution.value),
    attractors: state.params.attractors.map((attractor) => (
      attractor.enabled ? { ...attractor, strength: attractorStrength } : attractor
    ))
  };
}

function syncControlLabels() {
  elements.countLabel.textContent = formatNumber(state.activeCount);
  elements.gravityValue.textContent = state.params.gravityY.toFixed(1);
  elements.windValue.textContent = state.params.windX.toFixed(1);
  elements.strengthValue.textContent = String(Math.round(state.params.attractorStrength));
  elements.dragValue.textContent = state.params.drag.toFixed(2);
  elements.restitutionValue.textContent = state.params.restitution.toFixed(2);
  elements.pointSizeValue.textContent = Number(elements.pointSize.value).toFixed(1);
}

function publishParams() {
  state.params = normalizeParams(readControlParams());
  if (state.gpu) state.gpu.setParams(state.params);
  state.cpu?.post({ type: 'set-params', params: state.params });
  syncControlLabels();
}

function stopGpuLoop() {
  if (state.frameHandle) cancelAnimationFrame(state.frameHandle);
  state.frameHandle = 0;
}

function disposeGpu() {
  stopGpuLoop();
  state.gpu?.dispose();
  state.gpu = null;
}

function makeReplacementCanvas() {
  const replacement = document.createElement('canvas');
  replacement.id = 'particleCanvas';
  replacement.width = canvas.width;
  replacement.height = canvas.height;
  replacement.setAttribute('aria-label', 'CPU 降级粒子画布');
  canvas.replaceWith(replacement);
  canvas = replacement;
  return canvas;
}

async function startCpuFallback(reason, capacity = state.capacity, activeCount = state.activeCount) {
  disposeGpu();

  if (!('Worker' in window) || !('OffscreenCanvas' in window)) {
    const runner = new MainThreadCpuRunner(canvas, Math.min(capacity, activeCount), state.params);
    state.cpu = {
      post(message) {
        if (message.type === 'set-params') runner.setParams(normalizeParams(message.params));
        if (message.type === 'start') runner.start();
        if (message.type === 'pause') runner.pause();
      },
      listen(callback) {
        if (!runner.statListeners) runner.statListeners = new Set();
        runner.statListeners.add(callback);
        runner.onStats = (stats) => {
          runner.statListeners.forEach((listener) => listener({ type: 'cpu-stats', ...stats }));
        };
        return () => {};
      },
      dispose: () => runner.dispose()
    };
    state.capacity = runner.capacity;
    state.activeCount = runner.activeCount;
    elements.count.value = runner.capacity;
    setBackend('main', reason);
    elements.backendStatus.textContent = `已降级到主线程 Canvas2D：${reason}。该路径不保证主线程不卡。`;
    elements.memoryBadge.textContent = formatMebibytes(state.capacity * 4 * 4);
    elements.loading.hidden = true;
    state.cpu.listen((message) => {
      if (message.type === 'cpu-stats') {
        state.cpuStats = message;
        elements.fps.textContent = message.fps.toFixed(1);
        elements.physics.textContent = `${message.physicsMs.toFixed(2)} ms`;
        elements.gpuTime.textContent = 'main';
        elements.throughput.textContent = `${formatNumber(Math.round(message.activeCount * message.fps))} 粒子帧/s`;
      }
    });
    if (state.running) state.cpu.post({ type: 'start' });
    return;
  }

  async function launchCpuWorker(workerCapacity) {
    const fallbackCanvas = canvas.isConnected ? makeReplacementCanvas() : canvas;
    const offscreen = fallbackCanvas.transferControlToOffscreen();
    state.cpu?.dispose();
    state.cpu = new WorkerClient(new URL('./cpu-particle.worker.js', import.meta.url));

    const readyPromise = new Promise((resolve, reject) => {
      const remove = state.cpu.listen((message) => {
        if (message.type === 'cpu-ready') {
          remove();
          resolve(message);
        }
        if (message.type === 'cpu-error') {
          remove();
          reject(new Error(message.message));
        }
      });
      state.cpu.onError = (error) => {
        remove();
        reject(error instanceof Error ? error : new Error('CPU Worker failed to start'));
      };
    });

    state.cpu.post({
      type: 'init',
      canvas: offscreen,
      capacity: workerCapacity,
      activeCount: Math.min(activeCount, workerCapacity),
      params: state.params,
      preferWebGL: true,
      seed: 1337
    }, [offscreen]);

    return readyPromise;
  }

  let workerCapacity = capacity;
  let ready;
  try {
    ready = await launchCpuWorker(workerCapacity);
  } catch (error) {
    if (workerCapacity <= 100_000) throw error;
    workerCapacity = Math.floor(workerCapacity / 2);
    ready = await launchCpuWorker(workerCapacity);
    reason = `${reason}；CPU 内存降级到 ${formatNumber(workerCapacity)}`;
  }
  state.cpu.onError = null;

  state.capacity = workerCapacity;
  state.activeCount = Math.min(activeCount, workerCapacity);
  elements.count.value = workerCapacity;
  state.fallbackReasons.push(reason);
  setBackend('cpu', reason);
  elements.backendStatus.textContent = `已降级到 CPU Worker：${reason}。CPU 渲染后端：${ready.rendererType}。`;
  elements.memoryBadge.textContent = formatMebibytes(state.capacity * 4 * 4);
  elements.loading.hidden = true;
  setResult(`降级覆盖：${reason}。粒子计算和渲染均在 Worker 中执行，主线程仅处理 UI。`);

  if (state.running) state.cpu.post({ type: 'start' });

  state.cpu.listen((message) => {
    if (message.type === 'cpu-stats') {
      state.cpuStats = message;
      elements.fps.textContent = message.fps.toFixed(1);
      elements.physics.textContent = `${message.physicsMs.toFixed(2)} ms`;
      elements.gpuTime.textContent = 'CPU';
      elements.throughput.textContent = `${formatNumber(Math.round(message.activeCount * message.fps))} 粒子帧/s`;
    }
    if (message.type === 'cpu-count') {
      state.activeCount = message.activeCount;
      elements.count.value = message.activeCount;
      elements.countLabel.textContent = formatNumber(message.activeCount);
    }
  });
}

async function boot(forced = {}) {
  elements.loading.hidden = false;
  const support = forced.ignoreSupport
    ? { supported: true, message: 'forced', renderer: 'forced' }
    : detectGpuSupport();

  if (forced.cpu || !support.supported) {
    await startCpuFallback(forced.reason ?? support.reason ?? support.message);
    return;
  }

  try {
    state.capacity = clampParticles(Number(elements.count.value));
    state.activeCount = state.capacity;
    state.initialData = await createParticleData(state.capacity, state.params.bounds);

    if (forced.memoryFailure) {
      throw new GpuMemoryError('Simulated GPU out-of-memory', { simulated: true });
    }

    state.gpu = new GpuParticleSystem(canvas, {
      capacity: state.capacity,
      activeCount: state.activeCount,
      positions: state.initialData.positions,
      velocities: state.initialData.velocities,
      params: state.params,
      pointSize: Number(elements.pointSize.value)
    });

    setBackend('gpu');
    elements.backendStatus.textContent = `${support.message} GPU：${support.renderer}`;
    elements.memoryBadge.textContent = formatMebibytes(state.gpu.memoryBytes);
    elements.loading.hidden = true;
    setResult(`GPU transform feedback 已分配 ${formatNumber(state.capacity)} 个粒子，双缓冲 ${formatMebibytes(state.gpu.memoryBytes)}。`);
    state.statsStartedAt = performance.now();
    state.frameHandle = requestAnimationFrame(gpuFrame);

    state.gpu.contextLost.then((error) => {
      if (state.mode === 'gpu') startCpuFallback(error.message);
    });
  } catch (error) {
    if (error instanceof GpuMemoryError || error instanceof GpuCapabilityError) {
      await startCpuFallback(error.message);
    } else if (forced.ignoreSupport) {
      throw error;
    } else {
      await startCpuFallback(`粒子数据初始化失败：${error.message}`);
    }
  }
}

function gpuFrame(now) {
  if (!state.gpu || state.mode !== 'gpu') {
    state.frameHandle = 0;
    return;
  }

  const frameStart = performance.now();
  let gpuMs = null;
  if (state.running) gpuMs = state.gpu.frame();
  else state.gpu.render();

  drawOverlay();

  const frameMs = performance.now() - frameStart;
  state.frameSamples.push({ at: now, frameMs, gpuMs: gpuMs ?? state.gpu.getGpuTimeMs() });
  const cutoff = now - 1000;
  state.frameSamples = state.frameSamples.filter((sample) => sample.at >= cutoff);

  const fps = state.frameSamples.length;
  const averageFrame = state.frameSamples.reduce((sum, sample) => sum + sample.frameMs, 0) / Math.max(1, state.frameSamples.length);
  const latestGpu = [...state.frameSamples].reverse().find((sample) => Number.isFinite(sample.gpuMs))?.gpuMs;
  const longTasks = monitor.longTaskSummary(state.statsStartedAt);

  elements.fps.textContent = fps.toFixed(0);
  elements.physics.textContent = `${averageFrame.toFixed(2)} ms`;
  elements.gpuTime.textContent = latestGpu ? `${latestGpu.toFixed(2)} ms` : '扩展不可用';
  elements.longTask.textContent = `${longTasks.count}（${longTasks.maxMs.toFixed(0)} ms）`;
  elements.throughput.textContent = `${formatNumber(Math.round(state.activeCount * fps))} 粒子帧/s`;
  elements.bufferMemory.textContent = formatMebibytes(state.gpu.memoryBytes);

  state.frameHandle = requestAnimationFrame(gpuFrame);
}

function worldToCanvas(point) {
  const { bounds } = state.params;
  return {
    x: (point.x - bounds.xMin) / (bounds.xMax - bounds.xMin) * overlay.width,
    y: overlay.height - (point.y - bounds.yMin) / (bounds.yMax - bounds.yMin) * overlay.height
  };
}

function canvasToWorld(event) {
  const rect = overlay.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  const { bounds } = state.params;
  return {
    x: bounds.xMin + x * (bounds.xMax - bounds.xMin),
    y: bounds.yMax - y * (bounds.yMax - bounds.yMin)
  };
}

function drawOverlay() {
  const context = overlayContext;
  context.clearRect(0, 0, overlay.width, overlay.height);
  context.save();

  state.params.attractors.forEach((attractor, index) => {
    const point = worldToCanvas(attractor);
    context.beginPath();
    context.arc(point.x, point.y, 12, 0, Math.PI * 2);
    context.strokeStyle = !attractor.enabled
      ? '#718096'
      : attractor.strength >= 0 ? '#ffd166' : '#ff6b6b';
    context.globalAlpha = attractor.enabled ? 0.9 : 0.35;
    context.lineWidth = 2;
    context.stroke();
    context.globalAlpha = attractor.enabled ? 0.18 : 0.06;
    context.fillStyle = attractor.strength >= 0 ? '#ffd166' : '#ff6b6b';
    context.fill();
    context.globalAlpha = 1;
    context.fillStyle = '#ffffff';
    context.font = '12px system-ui';
    context.fillText(`A${index + 1}`, point.x + 15, point.y - 12);
  });

  context.restore();
}

function findAttractorAt(worldPoint) {
  const rect = overlay.getBoundingClientRect();
  const threshold = 18 / Math.min(rect.width, rect.height);
  let result = -1;
  let best = Infinity;

  state.params.attractors.forEach((attractor, index) => {
    const normalizedX = (attractor.x - worldPoint.x) / (state.params.bounds.xMax - state.params.bounds.xMin);
    const normalizedY = (attractor.y - worldPoint.y) / (state.params.bounds.yMax - state.params.bounds.yMin);
    const distance = Math.hypot(normalizedX, normalizedY);
    if (distance < threshold && distance < best) {
      best = distance;
      result = index;
    }
  });

  return result;
}

function bindOverlay() {
  overlay.addEventListener('pointerdown', (event) => {
    const world = canvasToWorld(event);
    const hit = findAttractorAt(world);

    if (hit >= 0) {
      if (event.altKey) {
        state.params.attractors[hit].enabled = !state.params.attractors[hit].enabled;
      } else {
        state.draggingAttractor = hit;
        overlay.setPointerCapture(event.pointerId);
      }
      publishParams();
      drawOverlay();
      return;
    }

    state.params.attractors[0] = { ...state.params.attractors[0], x: world.x, y: world.y, enabled: true };
    publishParams();
    drawOverlay();
  });

  overlay.addEventListener('pointermove', (event) => {
    if (state.draggingAttractor < 0) return;
    const world = canvasToWorld(event);
    state.params.attractors[state.draggingAttractor] = {
      ...state.params.attractors[state.draggingAttractor],
      x: world.x,
      y: world.y
    };
    publishParams();
  });

  overlay.addEventListener('pointerup', () => {
    state.draggingAttractor = -1;
  });
}

async function requestNewParticles(delta) {
  const requested = state.activeCount + delta;
  if (requested > MAX_PARTICLES) {
    const error = new ParticleOverflowError(requested, MAX_PARTICLES);
    setResult(`粒子溢出：${formatNumber(error.requested)} > ${formatNumber(error.maximum)}，已钳制到上限。`);
  }

  const target = clampParticles(requested);
  if (target === state.activeCount) return;

  if (target < state.activeCount) {
    state.gpu?.shrinkActive(target);
    state.cpu?.post({ type: 'set-count', activeCount: target });
    state.activeCount = target;
    elements.count.value = target;
    elements.countLabel.textContent = formatNumber(target);
    return;
  }

  const count = target - state.activeCount;
  const client = new WorkerClient(new URL('./data-factory.worker.js', import.meta.url));
  const created = await client.request({
    type: 'create-range',
    count,
    start: state.activeCount,
    bounds: state.params.bounds,
    seed: 1337 + state.activeCount
  });
  client.dispose();

  if (state.mode === 'gpu' && state.gpu) {
    state.gpu.appendParticles(created.positions, created.velocities);
  } else {
    state.cpu?.post({
      type: 'add-particles',
      positions: created.positions,
      velocities: created.velocities,
      startIndex: state.activeCount
    }, [created.positions.buffer, created.velocities.buffer]);
  }

  state.activeCount = target;
  elements.count.value = target;
  elements.countLabel.textContent = formatNumber(target);
  setResult(`动态更新：${delta > 0 ? '新增' : '减少'} ${formatNumber(Math.abs(delta))}，当前 ${formatNumber(target)}。`);
}

async function resetSystem() {
  const target = clampParticles(Number(elements.count.value));
  state.running = true;
  elements.toggleRun.textContent = '暂停';

  if (state.mode === 'gpu') {
    disposeGpu();
    state.capacity = target;
    state.activeCount = target;
    await boot({ ignoreSupport: true });
  } else {
    state.cpu?.post({ type: 'reset', capacity: target, activeCount: target, bounds: state.params.bounds, seed: 1337 });
    state.capacity = target;
    state.activeCount = target;
  }
}

function renderBenchmarkTable(cpu, gpu, comparison) {
  const row = (label, result) => `
    <tr>
      <td>${label}</td>
      <td>${formatNumber(Math.round(result.particleStepsPerSecond))}</td>
      <td>${result.meanMs.toFixed(3)}</td>
      <td>${result.p95Ms.toFixed(3)}</td>
      <td>${formatMebibytes(result.memoryBytes)}</td>
    </tr>`;

  elements.benchmarkPanel.hidden = false;
  elements.benchmarkResult.innerHTML = `
    <table>
      <thead><tr><th>后端</th><th>粒子步/秒</th><th>均值</th><th>P95</th><th>缓冲区</th></tr></thead>
      <tbody>${row('CPU Worker', cpu)}${row('GPU Transform Feedback', gpu)}</tbody>
    </table>
    <p>GPU 总耗时加速比：<b>${comparison.speedup.toFixed(2)}×</b>；吞吐加速比：<b>${comparison.particleSpeedup.toFixed(2)}×</b>。
    CPU P95 ${cpu.p95Ms.toFixed(2)} ms，GPU P95 ${gpu.p95Ms.toFixed(2)} ms。</p>`;
}

async function runBenchmark() {
  const capacity = clampParticles(Number(elements.count.value));
  const frames = capacity >= 500_000 ? 120 : 180;
  elements.benchmarkPanel.hidden = false;
  elements.benchmarkResult.textContent = `正在以 ${formatNumber(capacity)} 粒子运行 ${frames} 步隔离基准…`;

  const [cpu, data] = await Promise.all([
    runCpuBenchmark({ capacity, frames, params: state.params, bounds: state.params.bounds }),
    createParticleData(capacity, state.params.bounds)
  ]);
  const gpu = await runGpuBenchmark({ capacity, frames, params: state.params, bounds: state.params.bounds }, data);
  const comparison = compareBenchmarks(cpu, gpu);
  renderBenchmarkTable(cpu, gpu, comparison);
  setResult(`基准完成：GPU ${comparison.speedup.toFixed(2)}×，P95 ${gpu.p95Ms.toFixed(2)} ms；CPU P95 ${cpu.p95Ms.toFixed(2)} ms。`);
}

async function runValidation() {
  setResult('正在运行 120 步确定性 CPU/GPU 一致性校验，包含中途动态参数更新…');
  const result = await validateCpuGpuConsistency({
    count: 4096,
    steps: 120,
    params: state.params,
    bounds: state.params.bounds
  });

  setResult(
    `${result.passed ? '通过' : '失败'}：位置最大误差 ${result.position.max.toFixed(5)}（${result.position.firstMismatch}），`
    + `速度最大误差 ${result.velocity.max.toFixed(5)}（${result.velocity.firstMismatch}）。`
  );
}

function bindControls() {
  const paramInputs = [
    elements.gravityY,
    elements.windX,
    elements.attractorStrength,
    elements.drag,
    elements.restitution
  ];

  paramInputs.forEach((input) => input.addEventListener('input', publishParams));
  elements.pointSize.addEventListener('input', () => {
    const size = Number(elements.pointSize.value);
    state.gpu?.setPointSize(size);
    state.cpu?.post({ type: 'set-point-size', pointSize: size });
    syncControlLabels();
  });

  elements.count.addEventListener('change', resetSystem);
  elements.toggleRun.addEventListener('click', () => {
    state.running = !state.running;
    elements.toggleRun.textContent = state.running ? '暂停' : '继续';
    state.cpu?.post({ type: state.running ? 'start' : 'pause' });
  });
  $('reset').addEventListener('click', resetSystem);
  $('addParticles').addEventListener('click', () => requestNewParticles(50_000));
  $('removeParticles').addEventListener('click', () => requestNewParticles(-50_000));
  $('benchmark').addEventListener('click', () => {
    runBenchmark().catch((error) => setResult(`基准失败：${error.message}`));
  });
  $('validate').addEventListener('click', () => {
    runValidation().catch((error) => setResult(`一致性校验失败：${error.message}`));
  });
  $('forceCpu').addEventListener('click', async () => {
    state.running = true;
    await startCpuFallback('transform-feedback-unsupported');
  });
  $('forceOom').addEventListener('click', async () => {
    state.running = true;
    disposeGpu();
    await boot({ memoryFailure: true });
  });
}

function updateCpuLongTaskMetrics() {
  if (state.mode !== 'cpu' || !state.cpuStats) return;
  const longTasks = monitor.longTaskSummary(state.statsStartedAt);
  elements.longTask.textContent = `${longTasks.count}（${longTasks.maxMs.toFixed(0)} ms）`;
  elements.bufferMemory.textContent = formatMebibytes(state.activeCount * 4 * 4);
}

bindOverlay();
bindControls();
syncControlLabels();
drawOverlay();
setInterval(updateCpuLongTaskMetrics, 500);

boot().catch((error) => {
  console.error(error);
  elements.loading.hidden = true;
  elements.backendStatus.textContent = `启动失败：${error.message}`;
  setResult(error.stack ?? error.message);
});
