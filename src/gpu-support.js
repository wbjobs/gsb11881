import { createTransformProgram } from './gl-utils.js';

export function detectGpuSupport(canvas = document.createElement('canvas')) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance'
  });

  if (!gl) {
    return {
      supported: false,
      reason: 'webgl2-unavailable',
      message: 'WebGL2 is unavailable; using the CPU particle path.'
    };
  }

  const hasTransformFeedback = typeof gl.beginTransformFeedback === 'function'
    && typeof gl.transformFeedbackVaryings === 'function'
    && typeof gl.bindBufferBase === 'function';

  const rendererInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = rendererInfo ? gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL) : 'unknown';
  const timerQueries = Boolean(gl.getExtension('EXT_disjoint_timer_query_webgl2'));
  let transformFeedbackSupported = hasTransformFeedback;

  if (transformFeedbackSupported) {
    try {
      const probeProgram = createTransformProgram(gl);
      gl.deleteProgram(probeProgram);
    } catch {
      transformFeedbackSupported = false;
    }
  }

  const loseContext = gl.getExtension('WEBGL_lose_context');
  loseContext?.loseContext();

  if (!transformFeedbackSupported) {
    return {
      supported: false,
      reason: 'transform-feedback-unsupported',
      message: 'Transform feedback is unavailable; falling back to CPU particles.',
      renderer
    };
  }

  return {
    supported: true,
    renderer,
    timerQueries,
    message: 'WebGL2 transform feedback is available.'
  };
}
