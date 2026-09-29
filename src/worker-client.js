export class WorkerClient {
  constructor(url) {
    this.worker = new Worker(url, { type: 'module' });
    this.pending = new Map();
    this.listeners = new Set();
    this.nextId = 1;
    this.onError = null;

    this.worker.onmessage = (event) => {
      const message = event.data;
      this.listeners.forEach((listener) => listener(message));

      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.type.endsWith('error')) reject(new Error(message.message ?? 'Worker request failed'));
        else resolve(message);
      }
    };

    this.worker.onerror = (error) => {
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      this.onError?.(error);
    };
  }

  post(message, transfer = []) {
    this.worker.postMessage(message, transfer);
  }

  request(message, transfer = []) {
    const id = this.nextId++;
    const payload = { ...message, id };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(payload, transfer);
    });
  }

  listen(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose() {
    this.worker.terminate();
    this.pending.clear();
    this.listeners.clear();
  }
}
