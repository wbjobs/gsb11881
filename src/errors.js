export class GpuCapabilityError extends Error {
  constructor(message, reason = 'gpu-capability') {
    super(message);
    this.name = 'GpuCapabilityError';
    this.reason = reason;
  }
}

export class GpuMemoryError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'GpuMemoryError';
    this.reason = 'gpu-memory';
    this.detail = detail;
  }
}

export class ParticleOverflowError extends RangeError {
  constructor(requested, maximum) {
    super(`Particle count ${requested} exceeds maximum ${maximum}`);
    this.name = 'ParticleOverflowError';
    this.reason = 'particle-overflow';
    this.requested = requested;
    this.maximum = maximum;
  }
}

export class WorkerUnavailableError extends Error {
  constructor(message, reason = 'worker-unavailable') {
    super(message);
    this.name = 'WorkerUnavailableError';
    this.reason = reason;
  }
}
