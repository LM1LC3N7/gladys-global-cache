// -----------------------------------------------------------------------------
// GlobalCacheApp with the SDK's fake Gladys, the exact handlers of the
// container (src/handlers.js), fake gateways on real loopback TCP sockets, a
// memory store and a virtual clock: the timers only fire when the test
// advances the clock, and the monotonic clock moves 1 µs at each read (a
// decision that reads it twice is caught). Every wait is bounded: a test
// fails, never hangs.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { GlobalCacheApp } from '../../src/app.js';
import { parseHost } from '../../src/config.js';
import { registerHandlers } from '../../src/handlers.js';
import { MemoryStore } from '../../src/store.js';
import { startFakeGc } from './fakeGc.js';
import { createFakeClock } from './fakeTimers.js';

export const SELECTOR = 'global-cache';
export const NOW = 1_800_000_000_000;
export const D = (host) => `ext:${SELECTOR}:global-cache:${parseHost(host).id}`;
export const F = (host, key) => `${D(host)}:${key}`;

/** Waits (real time, bounded) until `condition()` holds; the I/O is real. */
export async function until(condition, ms = 3000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`condition not met in ${ms} ms: ${condition}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A promise that rejects after `ms` (real time): no test waits without end. */
export function within(promise, ms = 5000, what = 'promise') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} not settled in ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A logger that keeps every line. */
export function memoryLogger() {
  const lines = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => lines.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  return { logger, lines };
}

export async function setup(
  t,
  {
    model = 'IP2CC',
    fakes,
    config = {},
    store,
    devices = [],
    start = true,
    timings = {},
    connect,
  } = {},
) {
  const list = fakes ?? [await startFakeGc(model)];
  let app;
  // The app stops first (a release under way still reaches its gateway).
  t.after(async () => {
    await app?.stop();
    await Promise.all(list.map((f) => f.close()));
  });
  const fullConfig = {
    gateways: list.map((f) => f.host).join(', '),
    allow_relays: true,
    pulse_ms: 500,
    poll_interval: 30,
    ...config,
  };
  const gladys = createFakeGladys({ selector: SELECTOR, config: fullConfig, devices });
  const { clock, timers, advance, pending } = createFakeClock(NOW);
  let drift = 0;
  const { logger, lines } = memoryLogger();
  const kept = store ?? new MemoryStore(undefined, { now: () => clock.now });
  app = new GlobalCacheApp({
    gladys,
    logger,
    store: kept,
    timers,
    now: () => clock.now,
    monotonic: () => clock.now + (drift += 0.001),
    timings,
    ...(connect ? { connect } : {}),
  });
  registerHandlers(gladys, app, logger, timers);
  if (start) {
    await within(gladys.connect(), 5000, 'connect');
    await until(() => app.config);
  }
  /** Runs the due timers, then waits (real time) for the I/O they started. */
  const step = async (ms = 0) => {
    await advance(ms);
    await sleep(5);
  };
  /** Moves the virtual clock step by step until `condition()` holds. */
  const advanceUntil = async (condition, { ms = 600_000, every = 100 } = {}) => {
    for (let spent = 0; spent <= ms; spent += every) {
      if (condition()) return;
      await advance(every);
      await sleep(2);
    }
    if (!condition()) throw new Error(`condition not met in ${ms} virtual ms: ${condition}`);
  };
  const gateway = (i = 0) => [...app.gateways.values()][i];
  /** The first reading of a gateway done. */
  const ready = async (i = 0) => {
    await until(() => gateway(i)?.state === 'ok' && !gateway(i)?.current, 3000);
  };
  return {
    gladys,
    app,
    fake: list[0],
    fakes: list,
    lines,
    store: kept,
    clock,
    advance,
    pending,
    step,
    advanceUntil,
    gateway,
    ready,
  };
}

/** Creates every discovered device in the fake Gladys. */
export async function createAll(gladys) {
  await until(() => gladys.fake.discoveredDevices.length > 0);
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
}

/** A button press through the fake Gladys (the handler of the container): the ack. */
export function press(gladys, host, key, value = 1) {
  const feature = { external_id: F(host, key) };
  const device = gladys.fake.devices.find((d) => d.external_id === D(host)) ?? {
    external_id: D(host),
  };
  return within(gladys.fake.setValue(device, feature, value), 8000, 'ack');
}
