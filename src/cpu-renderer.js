import { createRenderProgram, getUniforms } from './gl-utils.js';
import { paramsToUniforms } from './physics.js';

export class Cpu2dRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
  }

  render(positions, velocities, count, params, width, height) {
    const context = this.context;
    const { xMin, xMax, yMin, yMax } = params.bounds;
    const scaleX = width / (xMax - xMin);
    const scaleY = height / (yMax - yMin);

    context.fillStyle = 'rgb(5, 6, 9)';
    context.fillRect(0, 0, width, height);

    for (let index = 0; index < count; index += 1) {
      const offset = index * 2;
      const speed = Math.min(1, Math.hypot(velocities[offset], velocities[offset + 1]) / 32);
      const x = (positions[offset] - xMin) * scaleX;
      const y = height - (positions[offset + 1] - yMin) * scaleY;
      const red = Math.round(40 + speed * 215);
      const green = Math.round(140 - speed * 24);
      const blue = Math.round(255 - speed * 224);
      context.fillStyle = `rgb(${red},${green},${blue})`;
      context.fillRect(x, y, 1.25, 1.25);
    }
  }
}

export class CpuWebGLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance'
    });
    if (!gl) throw new Error('WebGL2 renderer unavailable for CPU path');

    this.gl = gl;
    this.program = createRenderProgram(gl);
    this.uniforms = getUniforms(gl, this.program, [
      'u_boundsMin', 'u_boundsMax', 'u_pointSize'
    ]);
    this.vao = gl.createVertexArray();
    this.positionBuffer = gl.createBuffer();
    this.velocityBuffer = gl.createBuffer();

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.velocityBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  render(positions, velocities, count, params, pointSize = 1) {
    const gl = this.gl;
    const packed = paramsToUniforms(params);
    const byteLength = count * 2 * Float32Array.BYTES_PER_ELEMENT;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.018, 0.022, 0.032, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions.subarray(0, count * 2), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.velocityBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, velocities.subarray(0, count * 2), gl.DYNAMIC_DRAW);

    gl.uniform2fv(this.uniforms.u_boundsMin, packed.boundsMin);
    gl.uniform2fv(this.uniforms.u_boundsMax, packed.boundsMax);
    gl.uniform1f(this.uniforms.u_pointSize, pointSize);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.bindVertexArray(null);
  }
}

export function createCpuRenderer(canvas, preferWebGL = true) {
  if (preferWebGL) {
    try {
      return { type: 'webgl2', renderer: new CpuWebGLRenderer(canvas) };
    } catch {
      return { type: '2d', renderer: new Cpu2dRenderer(canvas) };
    }
  }
  return { type: '2d', renderer: new Cpu2dRenderer(canvas) };
}
