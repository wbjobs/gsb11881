import { checkGlError, PointRenderer } from '../gl-utils.js';

export class CpuParticleRenderer {
  static key = 'cpu';
  static label = 'CPU Worker + GPU 点渲染';

  constructor(gl) {
    this.gl = gl;
    this.renderer = new PointRenderer(gl, 'packed');
    this.buffer = gl.createBuffer();
    this.capacity = 0;
    this.count = 0;
  }

  allocate(capacity) {
    const gl = this.gl;
    this.capacity = capacity;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, capacity * 16, gl.DYNAMIC_DRAW);
    checkGlError(gl, 'CPU 粒子渲染缓冲区分配');
  }

  upload(buffer, count) {
    const gl = this.gl;
    this.count = count;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(buffer));
  }

  render() {
    this.renderer.drawPacked(this.buffer, this.count);
  }

  resize(width, height, dpr) {
    this.renderer.resize(width, height, dpr);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteBuffer(this.buffer);
    this.renderer.dispose();
  }
}
