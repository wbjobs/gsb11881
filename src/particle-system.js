import { CpuParticleRenderer } from './backends/cpu-renderer.js';
import { Canvas2dParticleRenderer } from './backends/canvas-2d-renderer.js';
import { TextureComputeBackend } from './backends/texture-backend.js';
import { TransformFeedbackBackend } from './backends/tf-backend.js';
import { createContext } from './gl-utils.js';

export function createParticleSystem(canvas, options = {}) {
  const requestedBackend = options.backend ?? 'auto';
  const warnings = [];
  let gl = null;
  let backend = null;
  let kind = requestedBackend;
  let usedFallback = false;

  const fallback = (reason) => {
    usedFallback = true;
    warnings.push(reason);
    kind = 'cpu';
  };

  if (requestedBackend !== 'cpu') {
    gl = options.gl ?? createContext(canvas, 2);

    if (!gl) {
      gl = options.gl ?? createContext(canvas, 1);
      if (requestedBackend === 'tf') {
        warnings.push('WebGL2/Transform Feedback 不可用，已尝试纹理计算或 CPU。');
      }
      warnings.push('WebGL2 不可用，已尝试 WebGL1 纹理计算。');
    }
  } else {
    gl = options.gl ?? createContext(canvas, 2) ?? createContext(canvas, 1);
  }

  if (!gl) {
    backend = new Canvas2dParticleRenderer(canvas);
    warnings.push('WebGL 不可用，已降级到 CPU Worker + Canvas2D 抽样可视化。');
    return createSystemResult(backend, 'cpu', true, warnings, null, options, canvas);
  }

  const disableTf = options.disableTf;
  const isWebGL2 = gl instanceof WebGL2RenderingContext;

  if (requestedBackend === 'cpu') {
    backend = new CpuParticleRenderer(gl);
  }

  if (kind !== 'cpu' && requestedBackend === 'tf' && (!isWebGL2 || disableTf)) {
    warnings.push('Transform Feedback 被禁用或不可用，正在选择替代路径。');
  }

  if (kind !== 'cpu' && requestedBackend === 'texture' && !TextureComputeBackend.supports(gl)) {
    warnings.push('浮点纹理计算不可用，正在降级到 CPU Worker。');
    kind = 'cpu';
  }

  if (kind !== 'cpu' && requestedBackend === 'tf' && isWebGL2 && !disableTf) {
    kind = 'tf';
  } else if (kind !== 'cpu' && requestedBackend === 'texture' && TextureComputeBackend.supports(gl)) {
    kind = 'texture';
  } else if (kind !== 'cpu' && isWebGL2 && !disableTf) {
    kind = 'tf';
  } else if (TextureComputeBackend.supports(gl)) {
    kind = 'texture';
    if (disableTf || !isWebGL2) {
      warnings.push('Transform Feedback 不可用，已降级为浮点纹理计算。');
    }
  } else {
    fallback('Transform Feedback 和浮点纹理计算均不可用，已降级为 CPU Worker。');
  }

  if (kind === 'tf') {
    try {
      backend = new TransformFeedbackBackend(gl, { forceOom: options.forceOom });
    } catch (error) {
      fallback(`Transform Feedback 初始化失败：${error.message}`);
    }
  } else if (kind === 'texture') {
    try {
      backend = new TextureComputeBackend(gl, { forceOom: options.forceOom });
    } catch (error) {
      fallback(`纹理计算不可用：${error.message}`);
    }
  }

  if (kind === 'cpu' && !(backend instanceof CpuParticleRenderer)) {
    backend = new CpuParticleRenderer(gl);
  }

  return {
    gl,
    backend,
    kind,
    usedFallback,
    warnings,

    allocate(capacity, initialData, activeCount = capacity) {
      if (kind === 'cpu') {
        backend.allocate(capacity);
        return { capacity, activeCount };
      }

      const memoryBytes = kind === 'tf'
        ? TransformFeedbackBackend.memoryBytes(capacity)
        : estimateTextureMemory(capacity);
      const budget = options.vramBudget ?? 192 * 1024 * 1024;

      if (memoryBytes > budget) {
        let capped = capacity;
        while (capped > 0 && estimateBackendMemory(kind, capped) > budget) {
          capped = Math.floor(capped / 2);
        }

        if (capped < 10000) {
          return switchToCpu(capacity, `粒子缓冲区预计需要 ${formatBytes(memoryBytes)}，超过预算，已降级。`);
        }

        warnings.push(`请求 ${capacity.toLocaleString()} 个粒子超过缓冲区预算，实际激活 ${capped.toLocaleString()} 个。`);
        capacity = capped;
        activeCount = Math.min(activeCount, capped);
      }

      try {
        backend.allocate(capacity, initialData, activeCount);
        return { capacity, activeCount };
      } catch (error) {
        return switchToCpu(capacity, `显存不足或 GPU 分配失败：${error.message}；已降级到 CPU Worker。`);
      }
    },

    dispose() {
      backend.dispose();
    }
  };

  function createSystemResult() {
    return {
      gl,
      backend,
      kind: 'cpu',
      usedFallback: true,
      warnings,
      is2d: true,
      allocate(capacity) {
        backend.allocate(capacity);
        return { capacity, activeCount: capacity };
      },
      dispose() {
        backend.dispose();
      }
    };
  }

  function switchToCpu(capacity, reason) {
    try {
      backend.dispose();
    } catch {
      // 旧 GPU 后端可能只完成了部分初始化，丢弃即可。
    }

    warnings.push(reason);
    kind = 'cpu';
    usedFallback = true;
    backend = new CpuParticleRenderer(gl);
    backend.allocate(capacity);
    return { capacity, activeCount: capacity, cpuFallback: true };
  }
}

export function estimateTextureMemory(count) {
  const size = 1 << Math.ceil(Math.log2(Math.max(1, Math.ceil(Math.sqrt(count)))));
  return size * size * 4 * 4 * 2;
}

function estimateBackendMemory(kind, count) {
  return kind === 'tf'
    ? TransformFeedbackBackend.memoryBytes(count)
    : estimateTextureMemory(count);
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unitIndex = -1;

  do {
    value /= 1024;
    unitIndex++;
  } while (value >= 1024 && unitIndex < units.length - 1);

  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
