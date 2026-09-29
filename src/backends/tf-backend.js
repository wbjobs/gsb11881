import { FIXED_DT } from '../physics.js';
import {
  PHYSICS_UNIFORM_NAMES,
  TRANSFORM_VERTEX_SHADER,
  SHADERS
} from '../shaders.js';
import {
  checkGlError,
  createProgram,
  getLocations,
  GpuTimer,
  PointRenderer,
  setPhysicsUniforms
} from '../gl-utils.js';

export class TransformFeedbackBackend {
  static key = 'tf';
  static label = 'GPU Transform Feedback';
  static supports(gl) {
    return gl instanceof WebGL2RenderingContext;
  }

  static memoryBytes(count) {
    return count * 4 * 4 * 2;
  }

  constructor(gl, options = {}) {
    this.gl = gl;
    this.forceOom = Boolean(options.forceOom);
    this.timer = new GpuTimer(gl);

    this.physicsProgram = createProgram(
      gl,
      TRANSFORM_VERTEX_SHADER,
      SHADERS.fragment,
      ['vPosition', 'vVelocity']
    );
    this.locations = getLocations(
      gl,
      this.physicsProgram,
      ['aPosition', 'aVelocity'],
      PHYSICS_UNIFORM_NAMES
    );

    this.renderer = new PointRenderer(gl, 'packed');
    this.buffers = [gl.createBuffer(), gl.createBuffer()];
    this.sourceIndex = 0;
    this.capacity = 0;
    this.count = 0;
    this.transformFeedback = gl.createTransformFeedback();
    this.vertexArray = gl.createVertexArray();
    this.gpuSeconds = null;
  }

  allocate(capacity, initialData = null, count = capacity) {
    if (this.forceOom) {
      throw new Error('已通过 forceOom=1 模拟 transform feedback 显存不足');
    }

    const gl = this.gl;
    this.capacity = capacity;
    this.count = count;
    const bytes = capacity * 16;

    for (const buffer of this.buffers) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.DYNAMIC_COPY);
      checkGlError(gl, 'Transform feedback 缓冲区分配');
    }

    if (initialData) {
      this.uploadInitial(initialData, count);
    }
  }

  uploadInitial(data, count = data.length / 4) {
    const gl = this.gl;
    this.count = count;

    for (const buffer of this.buffers) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * 4);
    }

    checkGlError(gl, 'Transform feedback 初始粒子上传');
    this.sourceIndex = 0;
  }

  update(params, dt = FIXED_DT) {
    const gl = this.gl;
    const source = this.buffers[this.sourceIndex];
    const target = this.buffers[1 - this.sourceIndex];

    gl.useProgram(this.physicsProgram);
    setPhysicsUniforms(gl, this.locations.uniforms, params, dt);

    gl.bindVertexArray(this.vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, source);
    gl.enableVertexAttribArray(this.locations.attributes.aPosition);
    gl.enableVertexAttribArray(this.locations.attributes.aVelocity);
    gl.vertexAttribPointer(this.locations.attributes.aPosition, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(this.locations.attributes.aVelocity, 2, gl.FLOAT, false, 16, 8);

    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.transformFeedback);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, target);

    this.timer.begin();
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);
    this.timer.end();

    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.bindVertexArray(null);
    this.sourceIndex = 1 - this.sourceIndex;
    this.gpuSeconds = this.timer.poll();
  }

  render() {
    this.renderer.drawPacked(this.buffers[this.sourceIndex], this.count);
  }

  resize(width, height, dpr) {
    this.renderer.resize(width, height, dpr);
  }

  reset(data) {
    this.uploadInitial(data, data.length / 4);
  }

  async trial(initialData, steps, params, dt = FIXED_DT) {
    const count = initialData.length / 4;
    const trial = new TransformFeedbackBackend(this.gl);

    try {
      trial.allocate(count, initialData, count);
      for (let i = 0; i < steps; i++) trial.update(params, dt);
      this.gl.finish();
      return readPacked(this.gl, trial.buffers[trial.sourceIndex], count);
    } finally {
      trial.dispose();
    }
  }

  readCurrent(count = this.count) {
    return readPacked(this.gl, this.buffers[this.sourceIndex], count);
  }

  dispose() {
    const gl = this.gl;
    this.timer.dispose();
    this.renderer.dispose();
    for (const buffer of this.buffers) gl.deleteBuffer(buffer);
    gl.deleteProgram(this.physicsProgram);
    gl.deleteTransformFeedback(this.transformFeedback);
    gl.deleteVertexArray(this.vertexArray);
  }
}

export function readPacked(gl, buffer, count) {
  const result = new Float32Array(count * 4);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.getBufferSubData(gl.ARRAY_BUFFER, 0, result);
  return result;
}
