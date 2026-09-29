import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

function installWorkerSelf() {
  const messages = [];
  globalThis.self = {
    postMessage(message, transfers = []) {
      messages.push({ message, transfers });
    },
    onmessage: null
  };
  return messages;
}

test('data factory worker answers create and range requests with id', async () => {
  const messages = installWorkerSelf();
  const moduleUrl = new URL('../src/data-factory.worker.js?data', import.meta.url);
  await import(moduleUrl);

  self.onmessage({ data: { type: 'create', id: 11, capacity: 8 } });
  self.onmessage({ data: { type: 'create-range', id: 12, count: 3, start: 2 } });

  assert.equal(messages[0].message.id, 11);
  assert.equal(messages[0].message.positions.length, 16);
  assert.equal(messages[1].message.id, 12);
  assert.equal(messages[1].message.positions.length, 6);
});

test('cpu particle worker initializes and accepts dynamic particle additions', async () => {
  const messages = installWorkerSelf();
  const moduleUrl = new URL('../src/cpu-particle.worker.js?cpu', import.meta.url);
  await import(moduleUrl);

  self.onmessage({
    data: {
      type: 'init',
      capacity: 8,
      activeCount: 4,
      params: {
        gravityY: -1,
        attractors: []
      }
    }
  });

  assert.equal(messages[0].message.type, 'cpu-ready');
  assert.equal(messages[0].message.activeCount, 4);

  const positions = new Float32Array([1, 2, 3, 4]);
  const velocities = new Float32Array([0, 0, 0, 0]);
  self.onmessage({
    data: {
      type: 'add-particles',
      startIndex: 4,
      positions,
      velocities
    }
  });

  assert.equal(messages[1].message.type, 'cpu-count');
  assert.equal(messages[1].message.activeCount, 6);
});
