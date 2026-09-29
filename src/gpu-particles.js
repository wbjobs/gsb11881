import {
  attributeLocations,
  createRenderProgram,
  createTransformProgram,
  getGlErrorLabel,
  getUniforms
} from './gl-utils.js';
import { GpuMemoryError } from './errors.js';
import { normalizeParams, paramsToUniforms } from './physics.js';

class TimerQueries {
  constructor(gl) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.queue = [];
    this.lastMs = null;
    this.active = false;

    if (this.ext) {
      for (let index = 0; index < 32; index += 1) {
        this.queue.push({ object: gl.createQuery(), busy: false });
      }
    }
  }

  begin() {
    if (!this.ext || this.queue.every((query) => query.busy)) return false;
    const query = this.queue.find((candidate) => !candidate.busy);
    query.busy = true;
    this.active = true;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query.object);
    return true;
  }

  end() {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.active = false;
  }

  poll(force = false) {
    if (!this.ext) return null;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);

    for (const query of this.queue) {
      if (!query.busy) continue;
      const available = gl.getQueryParameter(query.object, gl.QUERY_RESULT_AVAILABLE);
      if (!available && !force) continue;
      if (!disjoint) {
        this.lastMs = gl.getQueryParameter(query.object, gl.QUERY_RESULT) / 1_000_000;
      }
      query.busy = false;
    }

    return this.lastMs;
  }

  dispose() {
    if (!this.ext) return;
    for (const query of this.queue) this.gl.deleteQuery(query.object);
  }
}

export class GpuParticleSystem {
  constructor(canvas, options = {}) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      ...(options.contextAttributes ?? {})
    });
    if (!gl) throw new Error('WebGL2 context unavailable');

    this.gl = gl;
    this.canvas = canvas;
    this.capacity = options.capacity;
    this.activeCount = options.activeCount ?? this.capacity;
    this.params = normalizeParams(options.params);
    this.current = 0;
    this.stepCount = 0;
    this.pointSize = options.pointSize ?? 1;
    this.disposed = false;

    if (this.activeCount > this.capacity) {
      throw new RangeError('Active particle count exceeds GPU capacity');
    }

    this.computeProgram = createTransformProgram(gl);
    this.renderProgram = createRenderProgram(gl);
    this.computeUniforms = getUniforms(gl, this.computeProgram, [
      'u_gravity', 'u_wind', 'u_boundsMin', 'u_boundsMax',
      'u_attractors', 'u_dt', 'u_restitution', 'u_dragFactor'
    ]);
    this.renderUniforms = getUniforms(gl, this.renderProgram, [
      'u_boundsMin', 'u_boundsMax', 'u_pointSize'
    ]);

    this.locations = attributeLocations();
    this.positions = [gl.createBuffer(), gl.createBuffer()];
    this.velocities = [gl.createBuffer(), gl.createBuffer()];
    this.updateVaos = Array.from({ length: 2 }, () => [gl.createVertexArray(), gl.createVertexArray()]);
    this.renderVaos = Array.from({ length: 2 }, () => [gl.createVertexArray(), gl.createVertexArray()]);
    this.transformFeedback = gl.createTransformFeedback();
    this.timerQueries = new TimerQueries(gl);

    this._allocateBuffers();
    this._initializeBuffers(options.positions, options.velocities);
    this._configureVertexArrays();

    this.contextLost = new Promise((resolve) => {
      canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        this.disposed = true;
        resolve(new Error('WebGL context lost'));
      }, { once: true });
    });
  }

  get memoryBytes() {
    return this.capacity * 8 * Float32Array.BYTES_PER_ELEMENT;
  }

  _checkedError(operation) {
    const label = getGlErrorLabel(this.gl);
    if (label) {
      throw new GpuMemoryError(`GPU allocation failed during ${operation}: ${label}`, {
        operation,
        capacity: this.capacity,
        bytes: this.memoryBytes
      });
    }
  }

  _allocateBuffers() {
    const gl = this.gl;
    const byteLength = this.capacity * 2 * Float32Array.BYTES_PER_ELEMENT;

    try {
      for (const index of [0, 1]) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positions[index]);
        gl.bufferData(gl.ARRAY_BUFFER, byteLength, gl.DYNAMIC_COPY);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.velocities[index]);
        gl.bufferData(gl.ARRAY_BUFFER, byteLength, gl.DYNAMIC_COPY);
      }
      this._checkedError('particle buffer allocation');
      gl.finish();
      this._checkedError('particle buffer synchronization');
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  _initializeBuffers(positions, velocities) {
    if (!positions || !velocities) return;
    const gl = this.gl;

    for (const index of [0, 1]) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.positions[index]);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.velocities[index]);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, velocities);
    }
    this._checkedError('particle upload');
  }

  _bindSource(vao, sourceIndex) {
    const gl = this.gl;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positions[sourceIndex]);
    gl.enableVertexAttribArray(this.locations.position);
    gl.vertexAttribPointer(this.locations.position, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.velocities[sourceIndex]);
    gl.enableVertexAttribArray(this.locations.velocity);
    gl.vertexAttribPointer(this.locations.velocity, 2, gl.FLOAT, false, 0, 0);
  }

  _configureVertexArrays() {
    for (const source of [0, 1]) {
      for (const target of [0, 1]) {
        this._bindSource(this.updateVaos[target][source], source);
        this._bindSource(this.renderVaos[target][source], source);
      }
    }
    this.gl.bindVertexArray(null);
  }

  setParams(params) {
    this.params = normalizeParams(params);
  }

  setPointSize(size) {
    this.pointSize = size;
  }

  appendParticles(positions, velocities) {
    const gl = this.gl;
    const count = positions.length / 2;
    const startIndex = this.activeCount;
    const endIndex = startIndex + count;

    if (count === 0) return;
    if (endIndex > this.capacity) throw new RangeError('Particle upload exceeds GPU capacity');

    const target = 1 - this.current;
    const byteOffset = startIndex * 2 * Float32Array.BYTES_PER_ELEMENT;

    gl.bindBuffer(gl.COPY_READ_BUFFER, this.positions[this.current]);
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, this.positions[target]);
    gl.copyBufferSubData(
      gl.COPY_READ_BUFFER,
      gl.COPY_WRITE_BUFFER,
      0,
      0,
      startIndex * 2 * Float32Array.BYTES_PER_ELEMENT
    );
    gl.bindBuffer(gl.COPY_READ_BUFFER, this.velocities[this.current]);
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, this.velocities[target]);
    gl.copyBufferSubData(
      gl.COPY_READ_BUFFER,
      gl.COPY_WRITE_BUFFER,
      0,
      0,
      startIndex * 2 * Float32Array.BYTES_PER_ELEMENT
    );

    gl.bindBuffer(gl.ARRAY_BUFFER, this.positions[target]);
    gl.bufferSubData(gl.ARRAY_BUFFER, byteOffset, positions);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.velocities[target]);
    gl.bufferSubData(gl.ARRAY_BUFFER, byteOffset, velocities);

    this.current = target;
    this.activeCount = endIndex;
    this._checkedError('dynamic GPU append');
  }

  shrinkActive(count) {
    const nextCount = Math.max(0, Math.min(this.capacity, Math.trunc(count)));
    if (nextCount >= this.activeCount) return;

    const gl = this.gl;
    const zeroCount = this.activeCount - nextCount;
    const zeros = new Float32Array(zeroCount * 2);
    const byteOffset = nextCount * 2 * Float32Array.BYTES_PER_ELEMENT;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.positions[1 - this.current]);
    gl.bufferSubData(gl.ARRAY_BUFFER, byteOffset, zeros);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.velocities[1 - this.current]);
    gl.bufferSubData(gl.ARRAY_BUFFER, byteOffset, zeros);

    this.activeCount = nextCount;
    this._checkedError('active GPU count resize');
  }

  reset(positions, velocities) {
    this.current = 0;
    this.stepCount = 0;
    this.activeCount = positions.length / 2;
    this._initializeBuffers(positions, velocities);
  }

  _bindComputeUniforms() {
    const gl = this.gl;
    const uniforms = this.computeUniforms;
    const packed = paramsToUniforms(this.params);

    gl.uniform2fv(uniforms.u_gravity, packed.gravity);
    gl.uniform2fv(uniforms.u_wind, packed.wind);
    gl.uniform2fv(uniforms.u_boundsMin, packed.boundsMin);
    gl.uniform2fv(uniforms.u_boundsMax, packed.boundsMax);
    gl.uniform4fv(uniforms.u_attractors, packed.attractors);
    gl.uniform1f(uniforms.u_dt, this.params.dt);
    gl.uniform1f(uniforms.u_restitution, this.params.restitution);
    gl.uniform1f(uniforms.u_dragFactor, packed.dragFactor);
  }

  step(timed = false) {
    const gl = this.gl;
    const source = this.current;
    const target = 1 - source;
    let queryActive = false;

    if (timed) queryActive = this.timerQueries.begin();

    gl.useProgram(this.computeProgram);
    this._bindComputeUniforms();
    gl.bindVertexArray(this.updateVaos[target][source]);
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.transformFeedback);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.positions[target]);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 1, this.velocities[target]);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, this.activeCount);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 1, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.bindVertexArray(null);

    if (queryActive) this.timerQueries.end();

    this.current = target;
    this.stepCount += 1;
    return this.timerQueries.poll();
  }

  render() {
    const gl = this.gl;
    const uniforms = this.renderUniforms;
    const packed = paramsToUniforms(this.params);

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.018, 0.022, 0.032, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.renderProgram);
    gl.bindVertexArray(this.renderVaos[0][this.current]);
    gl.uniform2fv(uniforms.u_boundsMin, packed.boundsMin);
    gl.uniform2fv(uniforms.u_boundsMax, packed.boundsMax);
    gl.uniform1f(uniforms.u_pointSize, this.pointSize);
    gl.drawArrays(gl.POINTS, 0, this.activeCount);
    gl.bindVertexArray(null);

    return this.timerQueries.poll();
  }

  frame() {
    const gpuMs = this.step(true);
    this.render();
    return gpuMs;
  }

  readParticles(count = this.activeCount) {
    const gl = this.gl;
    const positions = new Float32Array(count * 2);
    const velocities = new Float32Array(count * 2);

    const previousVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positions[this.current]);
    gl.getBufferSubData(gl.ARRAY_BUFFER, 0, positions);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.velocities[this.current]);
    gl.getBufferSubData(gl.ARRAY_BUFFER, 0, velocities);
    gl.bindVertexArray(previousVao);

    return { positions, velocities };
  }

  getGpuTimeMs() {
    return this.timerQueries.poll();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;

    this.timerQueries.dispose();
    for (const vaoPair of [...this.updateVaos, ...this.renderVaos]) {
      vaoPair.forEach((vao) => gl.deleteVertexArray(vao));
    }
    [...this.positions, ...this.velocities].forEach((buffer) => gl.deleteBuffer(buffer));
    gl.deleteTransformFeedback(this.transformFeedback);
    gl.deleteProgram(this.computeProgram);
    gl.deleteProgram(this.renderProgram);
  }
}
