const MAX_DRAWN_POINTS = 120000;

export class Canvas2dParticleRenderer {
  static key = 'cpu-2d';
  static label = 'CPU Worker + Canvas2D 采样渲染';

  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    if (!this.context) throw new Error('Canvas2D 不可用');
    this.data = null;
    this.count = 0;
    this.dpr = 1;
  }

  allocate() {}

  upload(buffer, count) {
    this.data = new Float32Array(buffer);
    this.count = count;
  }

  render() {
    const ctx = this.context;
    const width = this.canvas.width;
    const height = this.canvas.height;

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#05070d';
    ctx.fillRect(0, 0, width, height);

    if (!this.data) return;

    ctx.globalCompositeOperation = 'lighter';
    const stride = Math.max(1, Math.ceil(this.count / MAX_DRAWN_POINTS));
    const pointSize = Math.max(1, Math.min(2, 1.2 * this.dpr));

    for (let i = 0; i < this.count; i += stride) {
      const offset = i * 4;
      const x = (this.data[offset] * 0.5 + 0.5) * width;
      const y = (0.5 - this.data[offset + 1] * 0.5) * height;
      const speed = Math.min(
        1,
        Math.hypot(this.data[offset + 2], this.data[offset + 3]) * 2.5
      );
      ctx.fillStyle = `rgba(${Math.round(46 + speed * 209)}, ${Math.round(
        140 - speed * 8
      )}, 255, 0.5)`;
      ctx.fillRect(x, y, pointSize, pointSize);
    }
  }

  resize(width, height, dpr) {
    this.dpr = dpr;
  }

  dispose() {
    this.data = null;
  }
}
