import test from 'node:test';
import assert from 'node:assert/strict';

const calls = [];

function makeGl() {
  return {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    TRANSFORM_FEEDBACK_BUFFER: 6,
    DYNAMIC_COPY: 7,
    FLOAT: 8,
    POINTS: 9,
    RASTERIZER_DISCARD: 10,
    TRANSFORM_FEEDBACK: 11,
    SEPARATE_ATTRIBS: 12,
    INTERLEAVED_ATTRIBS: 13,
    COLOR_BUFFER_BIT: 14,
    NO_ERROR: 0,
    QUERY_RESULT_AVAILABLE: 15,
    VERTEX_ARRAY_BINDING: 16,
    RENDERER: 17,
    createShader: () => ({}),
    shaderSource() {},
    compileShader() {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => 'shader error',
    deleteShader() {},
    createProgram: () => ({}),
    attachShader() {},
    bindAttribLocation() {},
    transformFeedbackVaryings() {},
    linkProgram() {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => 'program error',
    deleteProgram() {},
    getUniformLocation: () => ({}),
    createBuffer: () => ({}),
    createVertexArray: () => ({}),
    createTransformFeedback: () => ({}),
    createQuery: () => ({}),
    bufferData(...args) { calls.push(['bufferData', args.length]); },
    bufferSubData() {},
    copyBufferSubData(...args) { calls.push(['copyBufferSubData', ...args.slice(2)]); },
    bindBuffer() {},
    bindVertexArray() {},
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    useProgram() {},
    uniform2fv() {},
    uniform4fv() {},
    uniform1f() {},
    enable() {},
    disable() {},
    bindTransformFeedback() {},
    bindBufferBase() {},
    beginTransformFeedback() { calls.push(['beginTransformFeedback']); },
    endTransformFeedback() { calls.push(['endTransformFeedback']); },
    drawArrays(...args) { calls.push(['drawArrays', ...args]); },
    viewport() {},
    clearColor() {},
    clear() {},
    getError: () => 0,
    finish() {},
    getParameter: () => 0,
    getExtension: () => null,
    deleteBuffer() {},
    deleteVertexArray() {},
    deleteTransformFeedback() {},
    deleteQuery() {}
  };
}

test('GpuParticleSystem configures transform feedback and appends particles without stale ping-pong state', async () => {
  class HTMLCanvasElementMock {
    constructor() {
      this.width = 64;
      this.height = 64;
      this.listeners = new Map();
    }

    getContext() {
      return makeGl();
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }
  }

  globalThis.HTMLCanvasElement = HTMLCanvasElementMock;

  const { GpuParticleSystem } = await import('../src/gpu-particles.js');
  const { createParticleStorage, normalizeParams } = await import('../src/physics.js');
  const initial = createParticleStorage(8);
  const system = new GpuParticleSystem(new HTMLCanvasElementMock(), {
    capacity: 16,
    activeCount: 8,
    positions: initial.positions,
    velocities: initial.velocities,
    params: normalizeParams({ attractors: [] })
  });

  system.step(false);
  assert.equal(system.current, 1);
  assert.ok(calls.some(([name]) => name === 'beginTransformFeedback'));

  const newPositions = new Float32Array([1, 2, 3, 4]);
  const newVelocities = new Float32Array([0, 0, 0, 0]);
  system.appendParticles(newPositions, newVelocities);

  assert.equal(system.activeCount, 10);
  assert.equal(system.current, 0);
  assert.equal(
    calls.filter(([name]) => name === 'copyBufferSubData').length,
    2,
    'existing particles should be copied once per position and velocity buffer'
  );
});
