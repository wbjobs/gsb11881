function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index];
}

export class PerformanceMonitor {
  constructor() {
    this.longTasks = [];
    this.observer = null;
    this.supported = typeof PerformanceObserver !== 'undefined';
  }

  start() {
    if (!this.supported) return false;

    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === 'longtask') {
          this.longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
            name: entry.name
          });
          if (this.longTasks.length > 256) this.longTasks.shift();
        }
      }
    });

    try {
      this.observer.observe({ entryTypes: ['longtask'] });
      return true;
    } catch {
      this.supported = false;
      return false;
    }
  }

  longTaskSummary(since = 0) {
    const values = this.longTasks
      .filter((task) => task.startTime >= since)
      .map((task) => task.duration);

    return {
      count: values.length,
      totalMs: values.reduce((sum, value) => sum + value, 0),
      maxMs: values.length ? Math.max(...values) : 0
    };
  }

  static summarize(values) {
    return {
      mean: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length),
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
      max: values.length ? Math.max(...values) : 0
    };
  }
}
