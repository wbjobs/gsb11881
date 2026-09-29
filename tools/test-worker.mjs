import assert from 'node:assert/strict';

const messages = [];
const timeouts = [];

const workerScope = {
  performance: {
    now: () => nowValue,
    mark() {},
    clearMeasures() {},
    getEntriesByName: () => [{ duration: 12.5 }]
  },
  measure() {},
  postMessage(message, transfers = []) {
    messages.push({ message, transfers });
  },
  close() {},
  setTimeout(callback) {
    timeouts.push(callback);
    return timeouts.length;
  }
};

let nowValue = 0;
workerScope.globalThis = workerScope;

globalThis.self = workerScope;
globalThis.performance = workerScope.performance;
globalThis.performance.measure = workerScope.performance.measure;
globalThis.performance.mark = workerScope.performance.mark;
globalThis.performance.measure = workerScope.performance.measure;
globalThis.performance.clearMeasures = workerScope.performance.clearMeasures;
globalThis.performance.getEntriesByName = workerScope.performance.getEntriesByName;
globalThis.setTimeout = workerScope.setTimeout ?? ((callback) => {
  timeouts.push(callback);
  return timeouts.length;
});

await import('../src/sim-worker.js');

self.onmessage({
  data: {
    type: 'benchmark',
    count: 256,
    steps: 12,
    seed: 7
  }
});

assert.equal(messages.length, 1);
assert.equal(messages[0].message.type, 'benchmark-result');
assert.equal(messages[0].message.count, 256);
assert.equal(messages[0].message.steps, 12);
assert.ok(messages[0].message.elapsed >= 0);
assert.ok(messages[0].message.particlesPerSecond > 0);

messages.length = 0;
self.onmessage({
  data: {
    type: 'consistency',
    count: 64,
    steps: 8,
    seed: 9
  }
});

assert.equal(messages.length, 1);
assert.equal(messages[0].message.type, 'consistency-result');
assert.ok(messages[0].transfers.length === 2);
assert.equal(messages[0].message.initial.byteLength, 64 * 4 * 4);
assert.equal(messages[0].message.cpuFinal.byteLength, 64 * 4 * 4);

console.log('worker protocol ok');
