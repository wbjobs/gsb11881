import { PHYSICS_UNIFORM_NAMES, SHADERS } from './shaders.js';

export function createContext(canvas, version = 2) {
  const attributes = {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance'
  };

  if (version === 2) {
    return canvas.getContext('webgl2', attributes) || null;
  }

  return (
    canvas.getContext('webgl', attributes) ||
    canvas.getContext('experimental-webgl', attributes)
  );
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader 编译失败：${log}`);
  }

  return shader;
}

export function createProgram(gl, vertexSource, fragmentSource, transformVaryings = []) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);

  if (gl instanceof WebGL2RenderingContext && transformVaryings.length > 0) {
    gl.transformFeedbackVaryings(program, transformVaryings, gl.INTERLEAVED_ATTRIBS);
  }

 gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program 链接失败：${log}`);
  }

  return program;
}

export function getLocations(gl, program, attributes = [], uniforms = []) {
  const result = { program, attributes: {}, uniforms: {} };

  for (const name of attributes) {
    result.attributes[name] = gl.getAttribLocation(program, name);
  }

  for (const name of uniforms) {
    result.uniforms[name] = gl.getUniformLocation(program, name);
  }

  return result;
}

export function createStaticBuffer(gl, target, data, usage = gl.STATIC_DRAW) {
  const buffer = gl.createBuffer();
  gl.bindBuffer(target, buffer);
  gl.bufferData(target, data, usage);
  return buffer;
}

export function checkGlError(gl, label) {
  const error = gl.getError();
  if (error !== gl.NO_ERROR) {
    throw new Error(`${label}失败，WebGL 错误码 ${error}`);
  }
}

export function setPhysicsUniforms(gl, uniforms, params, dt) {
  gl.uniform1f(uniforms.uGravity, params.gravity);
  gl.uniform1f(uniforms.uWind, params.wind);
  gl.uniform1f(uniforms.uAttractorStrength, params.attractorStrength);
  gl.uniform1f(uniforms.uAttractorEnabled, params.attractorEnabled ? 1 : 0);
  gl.uniform2f(uniforms.uAttractor, params.attractorX, params.attractorY);
  gl.uniform1f(uniforms.uDt, dt);
}

export class PointRenderer {
  constructor(gl, mode = 'packed') {
    this.gl = gl;
    this.mode = mode;
    const vertexSource = mode === 'texture'
      ? SHADERS.textureRenderVertex
      : SHADERS.renderVertex;

    this.program = createProgram(gl, vertexSource, SHADERS.fragment);

    const uniforms = [
      'uPointSize',
      ...(mode === 'texture' ? ['uState', 'uTextureSize'] : [])
    ];
    const attributes = mode === 'texture' ? ['aIndex'] : ['aPosition', 'aVelocity'];
    this.locations = getLocations(gl, this.program, attributes, uniforms);
    this.indexBuffer = null;
  }

  ensureIndexBuffer(count) {
    if (this.indexBuffer && this.indexCapacity >= count) return;
    const gl = this.gl;
    const data = new Float32Array(count);
    for (let i = 0; i < count; i++) data[i] = i;
    this.indexBuffer = createStaticBuffer(gl, gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.indexCapacity = count;
  }

  resize(width, height, dpr) {
    const pointSize = Math.max(1, Math.min(2.2, 1.25 * dpr));
    this.pointSize = width < 700 ? pointSize * 0.85 : pointSize;
  }

  drawPacked(buffer, count) {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniform1f(this.locations.uniforms.uPointSize, this.pointSize ?? 1.4);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(this.locations.attributes.aPosition);
    gl.enableVertexAttribArray(this.locations.attributes.aVelocity);
    gl.vertexAttribPointer(this.locations.attributes.aPosition, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(this.locations.attributes.aVelocity, 2, gl.FLOAT, false, 16, 8);
    gl.drawArrays(gl.POINTS, 0, count);
  }

  drawTexture(stateTexture, textureWidth, count) {
    const gl = this.gl;
    this.ensureIndexBuffer(count);
    gl.useProgram(this.program);
    gl.uniform1f(this.locations.uniforms.uPointSize, this.pointSize ?? 1.4);
    gl.uniform1i(this.locations.uniforms.uState, 0);
    gl.uniform2f(this.locations.uniforms.uTextureSize, textureWidth, textureWidth);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, stateTexture);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuffer);
    gl.enableVertexAttribArray(this.locations.attributes.aIndex);
    gl.vertexAttribPointer(this.locations.attributes.aIndex, 1, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, count);
  }

  dispose() {
    const gl = this.gl;
    if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer);
    gl.deleteProgram(this.program);
  }
}

export class GpuTimer {
  constructor(gl) {
    this.gl = gl;
    this.extension = gl instanceof WebGL2RenderingContext
      ? gl.getExtension('EXT_disjoint_timer_query_webgl2')
      : null;
    this.ring = [];
    this.ringSize = 4;
    this.active = false;
    this.lastSeconds = null;
  }

  begin() {
    if (!this.extension || this.active || this.ring.length >= this.ringSize) return false;
    const gl = this.gl;
    const query = gl.createQuery();
    gl.beginQuery(this.extension.TIME_ELAPSED_EXT, query);
    this.ring.push({ query });
    this.active = true;
    return true;
  }

  end() {
    if (!this.extension || !this.active) return;
    this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
    this.active = false;
  }

  poll() {
    if (!this.extension) return null;
    const gl = this.gl;

    while (this.ring.length > 0) {
      const entry = this.ring[0];
      const query = entry.query;
      const available = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE);
      const disjoint = gl.getParameter(this.extension.GPU_DISJOINT_EXT);

      if (!available) break;

      this.ring.shift();
      if (!disjoint) {
        this.lastSeconds = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e9;
      }
      gl.deleteQuery(query);
    }

    return this.lastSeconds;
  }

  dispose() {
    if (!this.extension) return;
    for (const entry of this.ring) this.gl.deleteQuery(entry.query);
  }
}

export { PHYSICS_UNIFORM_NAMES };
