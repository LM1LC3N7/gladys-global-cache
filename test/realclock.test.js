// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, setTimeout) and fake
// gateways on real loopback sockets: the readings really leave every interval
// (time sped up 20 times: 10 s is 0.5 s), never sooner, never a cycle late;
// a pulse lasts its length on the real clock (not sped up). Every app is
// stopped in t.after, every wait is bounded.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { GlobalCacheApp } from '../src/app.js';
import { Gateway } from '../src/gateway.js';
import { registerHandlers } from '../src/handlers.js';
import { MemoryStore } from '../src/store.js';
import { startFakeGc } from './helpers/fakeGc.js';
import { createAll, press, until } from './helpers/app.js';

function realApp(t, fake, speed, config = {}) {
  const timers = {
    setTimeout: (fn, ms) => setTimeout(fn, Math.max(0, ms) / speed),
    clearTimeout: (id) => clearTimeout(id),
  };
  const gladys = createFakeGladys({
    selector: 'global-cache',
    config: { gateways: fake.host, allow_relays: true, poll_interval: 10, ...config },
  });
  const quiet = () => {};
  const logger = { info: quiet, warn: quiet, error: quiet, debug: quiet };
  const app = new GlobalCacheApp({
    gladys,
    logger,
    store: new MemoryStore(),
    timers,
    now: () => Date.now(),
    monotonic: () => performance.now() * speed,
  });
  registerHandlers(gladys, app, logger, timers);
  t.after(async () => {
    await app.stop();
    await fake.close();
  });
  return { gladys, app };
}

test('real clock x20: a reading every 10 s, measured from the start of the previous one', async (t) => {
  const fake = await startFakeGc('IP2CC', { latencyMs: 3 });
  const speed = 20;
  const { gladys, app } = realApp(t, fake, speed);
  const ticks = [];
  const original = Gateway.prototype.tick;
  Gateway.prototype.tick = function tick() {
    ticks.push(performance.now() * speed);
    return original.call(this);
  };
  t.after(() => {
    Gateway.prototype.tick = original;
  });
  await gladys.connect();
  await until(() => ticks.length >= 6, 10_000);
  await app.stop();
  const gaps = ticks.slice(1, 6).map((v, i) => v - ticks[i]);
  for (const gap of gaps) {
    assert.ok(gap >= 9_900 && gap <= 20_000, `gaps ${gaps.map(Math.round)}`);
  }
  // One reading per tick, never doubled.
  assert.ok(fake.requests('getversion').length <= ticks.length);
});

test('real clock: a pulse closes the contact for its length (500 ms), then opens it', async (t) => {
  const fake = await startFakeGc('IP2CC', { latencyMs: 20 });
  const { gladys } = realApp(t, fake, 1, { pulse_ms: 500, poll_interval: 3600 });
  await gladys.connect();
  await createAll(gladys);
  const ack = await press(gladys, fake.host, 'relay-1-2-pulse');
  assert.equal(ack.success, true, ack.error);
  await until(() => fake.history.length === 2, 3000);
  const [on, off] = fake.history;
  assert.deepEqual([on.value, off.value], [1, 0]);
  const length = off.at - on.at;
  assert.ok(length >= 480 && length <= 3000, `${length} ms`);
});

test('real clock: a silent gateway owing a release arms no 1 ms loop, no timeout warning', async (t) => {
  const fake = await startFakeGc('IP2CC');
  const timers = [];
  const real = {
    setTimeout: (fn, ms) => {
      timers.push(ms);
      return setTimeout(fn, ms);
    },
    clearTimeout: (id) => clearTimeout(id),
  };
  const warnings = [];
  const onWarning = (w) => warnings.push(w.name);
  process.on('warning', onWarning);
  const gladys = createFakeGladys({
    selector: 'global-cache',
    config: { gateways: fake.host, allow_relays: true, poll_interval: 3600 },
  });
  const quiet = () => {};
  const logger = { info: quiet, warn: quiet, error: quiet, debug: quiet };
  const app = new GlobalCacheApp({ gladys, logger, store: new MemoryStore(), timers: real });
  registerHandlers(gladys, app, logger, real);
  let retries = 0;
  const original = app.runRetries.bind(app);
  app.runRetries = () => {
    retries += 1;
    return original();
  };
  t.after(async () => {
    process.off('warning', onWarning);
    await app.stop();
    await fake.close();
  });
  await gladys.connect();
  await createAll(gladys);
  fake.silent = true;
  const ack = await press(gladys, fake.host, 'relay-1-1-release');
  assert.equal(ack.success, false);
  // 1.5 s timeout, then tries at +1 s and +2 s, each 1.5 s long.
  await new Promise((resolve) => setTimeout(resolve, 5000));
  // A few runs (the 1 ms loop made thousands); margin for a loaded machine.
  assert.ok(retries <= 10, `${retries} runs of the retry timer`);
  assert.ok(
    timers.every((ms) => Number.isFinite(ms)),
    'every timer finite',
  );
  assert.deepEqual(warnings, []);
});
