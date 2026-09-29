# 100 万 GPU 粒子（WebGL2 Transform Feedback）

这是一个无构建依赖的浏览器示例：GPU 使用 WebGL2 transform feedback 在双缓冲中更新粒子，CPU 对照路径使用 Web Worker + TypedArray，并优先通过 `OffscreenCanvas` 在 Worker 内绘制，避免粒子计算阻塞主线程。

## 运行

```bash
npm start
# 打开 http://localhost:8080
```

Worker 和 ES Module 需要通过 HTTP 加载，不要直接双击 `index.html`。

```bash
npm test
```

## 实现概览

- GPU 计算：`src/gpu-particles.js` + `src/gl-utils.js`，位置和速度各两个 VBO，逐帧 ping-pong。
- CPU 对照：`src/cpu-particle.worker.js` 执行同一份 `src/physics.js`，避免 CPU/GPU 公式分叉。
- 数据分配：`src/data-factory.worker.js` 生成 100 万 `Float32Array`，初始数据不占用主线程。
- 物理效果：重力、风力、线性阻尼、四吸引子、矩形边界碰撞与弹性恢复。
- 可视化：GPU 点精灵根据速度着色；2D overlay 显示可拖拽吸引子。
- 性能：`PerformanceObserver` 统计主线程 long task；面板展示 FPS、模拟耗时、GPU query、粒子吞吐和缓冲显存。
- 基准：独立 CPU Worker benchmark 和离屏 GPU benchmark，输出均值、P95、粒子步/秒和加速比。
- 一致性：小规模确定性数据跑 CPU/GPU 120 步，中途修改参数，比较位置和速度最大误差。

## 缓冲区

100 万粒子，每粒子有 `position.xy` 与 `velocity.xy`：

- 单个缓冲：`1,000,000 × 2 × 4 = 8 MiB`
- GPU 当前/下一位置 + 当前/下一速度：`32 MiB`
- CPU 初始位置与速度：约 `16 MiB`（Worker 中分配）

## 降级与异常覆盖

- WebGL2 或 transform feedback 不可用：自动进入 CPU Worker。
- GPU 缓冲分配失败或 GL `OUT_OF_MEMORY`：销毁 GPU 资源并切换到 CPU Worker。
- WebGL context lost：监听 `webglcontextlost` 后进入 CPU Worker。
- 粒子数超过 100 万：UI 滑块钳制到硬上限；动态新增到上限时提示 overflow。
- 动态更新：新增粒子由 Worker 生成后写入 CPU TypedArray 或 GPU 当前/下一缓冲；减少粒子会清零非活动区。
- CPU Worker 内存不足：Worker 上报 `cpu-memory`，由主界面提示，需要减小粒子数后重置。
- 不支持 Worker/OffscreenCanvas：极端情况下使用主线程 Canvas2D 兜底，并明确标识该路径不保证主线程不卡；现代 Chrome/Edge/Firefox 推荐用于完整验收。

## 验收路径

1. 打开页面，默认请求 1,000,000 粒子，后端标识为 `GPU TF`。
2. 查看 FPS、吞吐、32 MiB 缓冲和 long task；正常设备应保持平滑，主线程不长时间卡顿。
3. 调整重力、风力、阻尼、吸引强度；拖拽或 Alt 点击 overlay 中的吸引子。
4. 点击“新增 50k / 减少 50k”验证动态更新。
5. 点击“一致性校验”，要求位置/速度误差均在容差内。
6. 点击“CPU / GPU 基准”，记录 CPU Worker 与 GPU 的 P95 和粒子步/秒。
7. 点击“模拟 TF 不支持”，确认切换为 `CPU Worker · transform-feedback-unsupported`。
8. 点击“模拟显存不足”，确认销毁 GPU 后切换为 CPU Worker，界面仍可继续操作。

## 文件说明

- `index.html` / `src/styles.css`：验收界面。
- `src/app.js`：应用状态、UI、rAF、降级、基准调用。
- `src/physics.js`：CPU/GPU 共享物理参数和确定性 TypedArray 计算。
- `src/gpu-particles.js`：WebGL2 transform feedback ping-pong 和渲染。
- `src/gl-utils.js`：shader、program、uniform 与 attribute。
- `src/cpu-particle.worker.js`：CPU 模拟和 OffscreenCanvas 动画。
- `src/benchmark.js`、`src/cpu-benchmark.worker.js`：性能对照。
- `src/validation.js`、`src/cpu-validate.worker.js`：CPU/GPU 数值一致性。
- `test/physics.test.js`：Node 物理回归测试。
