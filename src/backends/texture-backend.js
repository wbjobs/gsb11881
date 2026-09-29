import { FIXED_DT } from '../physics.js';
import {
  checkGlError,
  createProgram,
  createStaticBuffer,
  getLocations,
  GpuTimer,
  PointRenderer,
  setPhysicsUniforms
} from '../gl-utils.js';
import { PHYSICS_UNIFORM_NAMES, SHADERS } from '../shaders.js';

export class TextureComputeBackend {
  static key = 'texture';
  static label = 'GPU 纹理计算';

  static supports(gl) {
    const isWebGL2 = gl instanceof WebGL2RenderingContext;
    const floatTexture = isWebGL2 || gl.getExtension('OES_texture_float');
    const vertexTextureFloat = isWebGL2 || gl.getExtension('OES_vertex_texture_float');
    const renderFloat = (isWebGL2 && gl.getExtension('EXT_color_buffer_float')) ||
      gl.getExtension('WEBGL_color_buffer_float');
    return Boolean(floatTexture && vertexTextureFloat && renderFloat);
  }

  constructor(gl, options = {}) {
    this.gl = gl;
    this.forceOom = Boolean(options.forceOom);
    const isWebGL2 = gl instanceof WebGL2RenderingContext;
    this.floatTexture = isWebGL2 || gl.getExtension('OES_texture_float');
    this.vertexTextureFloat = isWebGL2 || gl.getExtension('OES_vertex_texture_float');
    this.renderFloat = (isWebGL2 && gl.getExtension('EXT_color_buffer_float')) ||
      gl.getExtension('WEBGL_color_buffer_float');

    if (!this.floatTexture || !this.vertexTextureFloat || !this.renderFloat) {
      throw new Error('浮点纹理或浮点渲染目标不可用');
    }

    this.timer = isWebGL2 ? new GpuTimer(gl) : null;
    this.gpuSeconds = null;

    this.simProgram = createProgram(
      gl,
      SHADERS.fullscreenVertex,
      SHADERS.packedFragment
    );
    this.simLocations = getLocations(
      gl,
      this.simProgram,
      ['aCorner'],
      ['uState', ...PHYSICS_UNIFORM_NAMES]
    );

    this.cornerBuffer = createStaticBuffer(
      gl,
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW
    );

    this.framebuffer = gl.createFramebuffer();
    this.textures = [gl.createTexture(), gl.createTexture()];
    this.sourceIndex = 0;
    this.textureSize = 0;
    this.capacity = 0;
    this.count = 0;
    this.renderer = new PointRenderer(gl, 'texture');
  }

  allocate(capacity, initialData = null, count = capacity) {
    if (this.forceOom) {
      throw new Error('已通过 forceOom=1 模拟纹理显存不足');
    }

    const gl = this.gl;
    this.textureSize = textureSizeForCount(gl, capacity);
    this.capacity = this.textureSize * this.textureSize;
    this.count = count;

    for (const texture of this.textures) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        this.textureSize,
        this.textureSize,
        0,
        gl.RGBA,
        gl.FLOAT,
        null
      );
      checkGlError(gl, '浮点粒子纹理分配');
    }

    if (initialData) this.uploadInitial(initialData, count);
    this.verifyFramebuffer();
  }

  uploadInitial(data, count = data.length / 4) {
    const gl = this.gl;
    this.count = count;
    const texels = this.textureSize * this.textureSize;
    let payload = data;

    if (data.length < texels * 4) {
      payload = new Float32Array(texels * 4);
      payload.fill(-2);
      payload.set(data);
    }

    for (const texture of this.textures) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        this.textureSize,
        this.textureSize,
        gl.RGBA,
        gl.FLOAT,
        payload
      );
    }

    checkGlError(gl, '浮点纹理初始粒子上传');
    this.sourceIndex = 0;
  }

  verifyFramebuffer() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.textures[1 - this.sourceIndex],
      0
    );

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`浮点纹理帧缓冲不完整，状态码 ${status}`);
    }
  }

  update(params, dt = FIXED_DT) {
    const gl = this.gl;
    const source = this.textures[this.sourceIndex];
    const target = this.textures[1 - this.sourceIndex];

    gl.useProgram(this.simProgram);
    setPhysicsUniforms(gl, this.simLocations.uniforms, params, dt);
    gl.uniform1i(this.simLocations.uniforms.uState, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      target,
      0
    );
    gl.viewport(0, 0, this.textureSize, this.textureSize);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer);
    gl.enableVertexAttribArray(this.simLocations.attributes.aCorner);
    gl.vertexAttribPointer(this.simLocations.attributes.aCorner, 2, gl.FLOAT, false, 0, 0);

    if (this.timer) this.timer.begin();
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (this.timer) this.timer.end();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    this.sourceIndex = 1 - this.sourceIndex;
    if (this.timer) this.gpuSeconds = this.timer.poll();
  }

  render(width, height) {
    this.gl.viewport(0, 0, width, height);
    this.renderer.drawTexture(this.textures[this.sourceIndex], this.textureSize, this.count);
  }

  resize(width, height, dpr) {
    this.renderer.resize(width, height, dpr);
  }

  reset(data) {
    this.uploadInitial(data, data.length / 4);
  }

  async trial(initialData, steps, params, dt = FIXED_DT) {
    const trial = new TextureComputeBackend(this.gl);

    try {
      trial.allocate(initialData.length / 4, initialData, initialData.length / 4);
      for (let i = 0; i < steps; i++) trial.update(params, dt);
      this.gl.finish();
      return trial.readCurrent(initialData.length / 4);
    } finally {
      trial.dispose();
    }
  }

  readCurrent(count = this.count) {
    const gl = this.gl;
    const result = new Float32Array(this.textureSize * this.textureSize * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.textures[this.sourceIndex],
      0
    );
    gl.viewport(0, 0, this.textureSize, this.textureSize);
    gl.readPixels(
      0,
      0,
      this.textureSize,
      this.textureSize,
      gl.RGBA,
      gl.FLOAT,
      result
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return result.subarray(0, count * 4);
  }

  dispose() {
    const gl = this.gl;
    if (this.timer) this.timer.dispose();
    this.renderer.dispose();
    gl.deleteBuffer(this.cornerBuffer);
    for (const texture of this.textures) gl.deleteTexture(texture);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteProgram(this.simProgram);
  }
}

export function textureSizeForCount(gl, count) {
  const size = Math.max(1, Math.ceil(Math.sqrt(count)));
  const powerOfTwo = 1 << Math.ceil(Math.log2(size));
  const maximum = gl && typeof gl.getParameter === 'function'
    ? gl.getParameter(gl.MAX_TEXTURE_SIZE)
    : 4096;

  if (powerOfTwo > maximum) {
    throw new Error(`需要 ${powerOfTwo}px 粒子纹理，超过设备 ${maximum}px 限制`);
  }

  return powerOfTwo;
}
