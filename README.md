# 百万粒子：WebGL Transform Feedback / 纹理计算 / CPU Worker 对照

这是一个无构建依赖的静态示例，用 100 万粒子展示 GPU 物理、CPU Worker 物理、动态外力和量化性能对照。

## 运行

```bash
python3 -m http.server 8080
```

然后打开 `http://localhost:8080/`。不要直接用 `file://`，ES Module Worker 需要 HTTP 源。

## 实现路径

- **GPU Transform Feedback**：WebGL2 中使用两个交错 `(x, y, vx, vy)` 缓冲区做 ping-pong；物理输出不经过光栅化。
- **GPU 纹理计算**：WebGL1/WebGL2 使用两个 RGBA `FLOAT` 纹理和一个全屏三角形；用于 transform feedback 不支持时的 GPU 降级。
- **CPU Worker**：物理积分运行在 Web Worker 中，主线程只接收 `ArrayBuffer` 快照并用 WebGL 点精灵绘制。
- **Canvas2D 兜底**：WebGL 完全不可用时，Worker 仍计算完整粒子数，Canvas2D 抽样绘制最多 12 万个点，避免主线程被绘制拖死。

三条计算路径共用同一固定步长 `1/60`、同一初始种子和同一物理公式：

- 重力
- 水平风力
- 可开关吸引子
- 矩形边界反弹
- 速度阻尼

## 验收点对应

- **100 万粒子不卡**：GPU 路径在 GPU 上更新和绘制，主线程不同步调用 `gl.finish()`。
- **CPU 与 GPU 结果一致**：点击“一致性校验”，用 4096 个确定性粒子运行 60 步，对比 CPU Worker 和当前 GPU 后端的 Float32 输出。
- **性能对照可量化**：点击“性能对照”，分别在 CPU Worker 和 GPU 上运行相同初始数据、相同参数、300 个固定步，输出总耗时与“粒子步数/秒”。
- **Transform Feedback 不支持**：打开 `?disableTf=1`，自动选择浮点纹理计算；纹理也不可用时降级 CPU Worker。
- **显存不足**：打开 `?forceOom=1` 模拟 GPU 缓冲区分配失败；或用较小预算 `?vramBudget=16m` 触发容量裁剪/CPU 降级。
- **粒子溢出**：选择 200 万粒子，系统根据显存档位裁剪激活数量并显示“激活/请求/缓冲容量”。
- **动态更新**：拖动重力、风力、吸引强度滑块；在画布上拖拽可移动吸引子，参数立即进入 CPU/GPU uniform。
- **主线程不卡**：CPU 积分在 Worker；页面用 `PerformanceObserver` 统计 `longtask` 次数、累计耗时和峰值。
- **可视化准确**：点位置来自真实模拟状态；颜色按速度从蓝色过渡到橙色。

## URL 测试参数

- `?backend=auto|tf|texture|cpu`：手动选择首选后端；不可用时仍自动降级。
- `?disableTf=1`：模拟 WebGL2 transform feedback 不可用。
- `?forceOom=1`：模拟 GPU 显存分配失败。
- `?vramBudget=16m`：限制 GPU 缓冲区预算；支持 `m` 或 `g`，例如 `256m`、`1g`。

## 主要文件

- `src/physics.js`：确定性初始状态、CPU 参考物理和共享物理常量。
- `src/shaders.js`：transform feedback、纹理计算和点渲染 shader。
- `src/backends/tf-backend.js`：WebGL2 transform feedback 后端。
- `src/backends/texture-backend.js`：浮点纹理 GPGPU 后端。
- `src/sim-worker.js`：CPU 物理、快照传输、CPU 基准和一致性参考。
- `src/main.js`：生命周期、UI、动态参数、基准和性能面板。

## 性能口径

面板中的“吞吐”按 `激活粒子数 × FPS × 每帧固定步` 计算。性能对照按钮使用固定 300 步，并在每个 GPU 分块后同步一次，以得到可重复的总耗时；普通动画循环不做同步等待。
