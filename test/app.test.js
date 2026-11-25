// -----------------------------------------------------------------------------
// The app against fake gateways: readings, Discovery, states, status, the
// configuration from Gladys, the period of the readings.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { RateLimiter } from '../src/events.js';
import { startOnConnect } from '../src/handlers.js';
import { startFakeGc } from './helpers/fakeGc.js';
import { D, DEAD_PORT, F, createAll, press, setup, until, within } from './helpers/app.js';

const reads = (fake) => fake.requests('getversion').length;

test('IP2CC: read, discovered with 3 relays (state, pulse, release), never a switch', async (t) => {
  const s = await setup(t);
  await s.ready();
  await until(() => s.gladys.fake.discoveredDevices.length === 1);
  const device = s.gladys.fake.discoveredDevices[0];
  assert.equal(device.external_id, D(s.fake.host));
  assert.equal(device.features.length, 9);
  assert.deepEqual(
    device.params.find((p) => p.name === 'model'),
    { name: 'model', value: 'iTach IP2CC' },
  );
  for (const f of device.features) {
    assert.ok(['input', 'button'].includes(f.category), f.category);
    for (const key of ['name', 'min', 'max', 'read_only', 'has_feedback']) {
      assert.notEqual(f[key], undefined, `${f.external_id}.${key}`);
    }
    // Core rules for supported_options: none published here.
    assert.equal(f.supported_options, undefined);
  }
  assert.equal(s.gladys.fake.connectionStatus.connected, true);
});

test('GC-100, IP2IR and Flex relay-sensor cable: their relays, inputs and IR outputs', async (t) => {
  const fakes = [
    await startFakeGc('GC100'),
    await startFakeGc('IP2IR'),
    await startFakeGc('FLEXRS'),
  ];
  const s = await setup(t, { fakes });
  await until(() => s.gladys.fake.discoveredDevices.length === 3, 4000);
  const byModel = Object.fromEntries(
    s.gladys.fake.discoveredDevices.map((d) => [d.params.find((p) => p.name === 'model').value, d]),
  );
  const keys = (d) => d.features.map((f) => f.external_id.split(':').at(-1));
  const irPorts = (d) => d.params.find((p) => p.name === 'ir_ports').value;
  const gc = byModel['GC-100-12'];
  assert.deepEqual(
    keys(gc).filter((k) => k.endsWith('-pulse')),
    ['relay-3-1-pulse', 'relay-3-2-pulse', 'relay-3-3-pulse'],
  );
  assert.ok(keys(gc).includes('sensor-4-3'));
  assert.equal(irPorts(gc), '4:1, 4:2, 5:1, 5:2, 5:3');
  const ir = byModel['iTach IP2IR'];
  assert.deepEqual(keys(ir), ['sensor-1-2']);
  assert.equal(irPorts(ir), '1:1, 1:3');
  const flex = byModel['Flex WiFi'];
  // SPDT and unavailable logical relays are left out (a pulse means SPST).
  assert.deepEqual(
    keys(flex).filter((k) => k.endsWith('-pulse')),
    ['relay-1-1-pulse', 'relay-1-2-pulse'],
  );
  assert.deepEqual(
    keys(flex).filter((k) => k.startsWith('sensor')),
    ['sensor-2-1', 'sensor-2-2', 'sensor-2-3', 'sensor-2-4'],
  );
});

test('states: only for a created device, only on change, from fresh readings only', async (t) => {
  const s = await setup(t, { model: 'IP2IR' });
  await s.ready();
  assert.equal(s.gladys.fake.states.length, 0, 'nothing before the device is created');
  await createAll(s.gladys);
  await s.step(30_000);
  await until(() => s.gladys.fake.lastState(F(s.fake.host, 'sensor-1-2')) === 0);
  const count = s.gladys.fake.states.length;
  await s.step(30_000);
  await until(() => !s.app.gateways.values().next().value.busy);
  assert.equal(s.gladys.fake.states.length, count, 'unchanged: not published again');
  s.fake.state.sensors.set('1:2', 1);
  await s.step(30_000);
  await until(() => s.gladys.fake.lastState(F(s.fake.host, 'sensor-1-2')) === 1);
  // A reconnection: nothing republished until the next reading, then fresh.
  const after = s.gladys.fake.states.length;
  await within(s.gladys.disconnect(), 3000);
  await within(s.gladys.connect(), 3000);
  await until(() => s.app.lastStatus !== undefined);
  assert.equal(s.gladys.fake.states.length, after);
  await s.step(30_000);
  await until(() => s.gladys.fake.states.length === after + 1);
});

test('a reading every 30 s; a saved configuration, a reconnection, the test button: never sooner', async (t) => {
  const s = await setup(t);
  await s.ready();
  assert.equal(reads(s.fake), 1);
  await s.step(29_000);
  assert.equal(reads(s.fake), 1);
  await s.step(1000);
  await until(() => reads(s.fake) === 2);
  await within(s.gladys.fake.configUpdated({ ...s.gladys.fake.config }), 3000);
  await within(s.gladys.disconnect(), 3000);
  await within(s.gladys.connect(), 3000);
  const ack = await within(s.gladys.fake.action('test_connection'), 3000);
  assert.equal(ack.success, true);
  await s.step(1000);
  assert.equal(reads(s.fake), 2);
  // 6 s after the last reading, the test button reads.
  await s.step(5000);
  await within(s.gladys.fake.action('test_connection'), 3000);
  assert.equal(reads(s.fake), 3);
  // A new interval: counted from the last periodic reading.
  await within(s.gladys.fake.configUpdated({ ...s.gladys.fake.config, poll_interval: 60 }), 3000);
  await s.step(53_000);
  assert.equal(reads(s.fake), 3);
  await s.step(1000);
  await until(() => reads(s.fake) === 4);
});

test('the configuration unreadable at a reconnection: status, asked again 5 s later, then running', async (t) => {
  const s = await setup(t, { start: false });
  const original = s.gladys.getConfig.bind(s.gladys);
  // The SDK reads it once while connecting; our handler's read fails once.
  let calls = 0;
  s.gladys.getConfig = () => (++calls === 2 ? Promise.reject(new Error('busy')) : original());
  await within(s.gladys.connect(), 3000);
  await until(() => /illisible/.test(s.gladys.fake.connectionStatus?.message?.fr ?? ''));
  assert.equal(s.app.config, undefined);
  await s.step(5000);
  await until(() => s.app.config !== undefined);
  await s.ready();
});

test('another model at the address of a created device: no state, not in Discovery, said in the status', async (t) => {
  const s = await setup(t);
  await s.ready();
  await createAll(s.gladys);
  s.fake.version = '710-1005-05';
  await s.step(30_000);
  await until(() => s.app.gateways.values().next().value.state === 'other');
  await until(() => s.gladys.fake.discoveredDevices.length === 0);
  assert.match(s.gladys.fake.connectionStatus.message.fr, /IP2IR répond à la place/);
  const count = s.gladys.fake.states.length;
  await s.step(30_000);
  assert.equal(s.gladys.fake.states.length, count);
});

test('unreachable, not a Global Caché, flooding: their status; the other gateways run', async (t) => {
  const good = await startFakeGc('IP2CC');
  const flood = await startFakeGc('IP2CC');
  flood.hooks.push((line) => (line === 'getdevices' ? 'x'.repeat(300) : undefined));
  const http = net.createServer((socket) =>
    socket.on('data', () => socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')),
  );
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => http.close(resolve)));
  const s = await setup(t, {
    fakes: [good, flood],
    config: {
      gateways: `${good.host}, ${flood.host}, 127.0.0.1:${http.address().port}, 127.0.0.1:${DEAD_PORT}`,
    },
  });
  await s.advanceUntil(
    () => [...s.app.gateways.values()].every((g) => g.state !== 'starting' && !g.busy),
    { ms: 10_000, every: 50 },
  );
  const states = [...s.app.gateways.values()].map((g) => g.state);
  assert.deepEqual(states, ['ok', 'answer', 'answer', 'down']);
  assert.equal(s.gladys.fake.connectionStatus.connected, true);
  assert.match(s.gladys.fake.connectionStatus.message.fr, /injoignable/);
  assert.match(s.gladys.fake.connectionStatus.message.fr, /réponse inattendue/);
});

test('notifications of other ports during a reading are not answers', async (t) => {
  const s = await setup(t, { model: 'GC100' });
  await s.ready();
  await createAll(s.gladys);
  s.fake.hooks.push((line, conn, socket) => {
    if (line === 'getstate,4:3') socket.write('statechange,4:3,1\rstate,3:1,1\r');
    return undefined;
  });
  await s.step(30_000);
  await s.advanceUntil(() => !s.app.gateways.values().next().value.busy, { ms: 3000, every: 50 });
  await until(() => s.gladys.fake.lastState(F(s.fake.host, 'sensor-4-3')) === 0);
  assert.equal(s.gladys.fake.lastState(F(s.fake.host, 'relay-3-1-state')), 0);
});

test('a gateway removed from the configuration during a pulse: its release still goes', async (t) => {
  const s = await setup(t);
  await s.ready();
  await createAll(s.gladys);
  assert.equal((await press(s.gladys, s.fake.host, 'relay-1-2-pulse')).success, true);
  await within(
    s.gladys.fake.configUpdated({ ...s.gladys.fake.config, gateways: '10.9.9.9' }),
    3000,
  );
  await s.advanceUntil(() => s.fake.state.relays.get('1:2') === 0, { ms: 3000, every: 50 });
  await s.advanceUntil(() => !s.app.gateways.has(s.fake.host), { ms: 3000, every: 50 });
});

test('300 states per minute at most', () => {
  const limiter = new RateLimiter(300);
  assert.equal(limiter.take(0, 300), true);
  assert.equal(limiter.take(1), false);
  assert.equal(limiter.take(60_000), true);
});

test('the status never shows a typed value back; relays off said', async (t) => {
  const s = await setup(t, { config: { allow_relays: false, gateways: 'bad host, 10.0.0.300' } });
  await until(() => s.gladys.fake.connectionStatus);
  const text = JSON.stringify(s.gladys.fake.connectionStatus);
  assert.ok(!text.includes('bad host') && !text.includes('10.0.0.300'));
  assert.match(text, /Aucune adresse valable/);
});

test('the test button during a reading joins it, never a second one', async (t) => {
  const s = await setup(t);
  await s.ready();
  s.fake.mute.add('getstate,1:2');
  await s.step(30_000);
  await until(() => s.fake.requests('getstate,1:2').length === 2);
  const pending = within(s.gladys.fake.action('test_connection'), 5000);
  await s.advanceUntil(() => !s.app.gateways.values().next().value.busy, { ms: 5000, every: 50 });
  assert.equal((await pending).success, true);
  assert.equal(reads(s.fake), 2);
});

test('two quick reconnections: the configuration of the latest one wins', async (t) => {
  const s = await setup(t, { start: false });
  const original = s.gladys.getConfig.bind(s.gladys);
  let slowDone = false;
  let late;
  s.gladys.getConfig = async () => {
    // The first read of our handler is slow (an old configuration), the next one quick.
    if (!slowDone && !late) {
      const config = await original();
      await new Promise((resolve) => (late = resolve));
      slowDone = true;
      return { ...config, gateways: '10.9.9.9' };
    }
    return original();
  };
  const connecting = s.gladys.connect();
  await until(() => late);
  s.gladys.emit('connected');
  await until(() => s.app.config);
  late();
  await within(connecting, 3000);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(
    s.app.config.hosts.map((h) => h.key),
    [s.fake.host],
  );
});

test('startOnConnect: a configuration read for an older connection is never applied', async () => {
  const started = [];
  let late;
  let calls = 0;
  const gladys = {
    getConfig: () => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => (late = resolve));
      return Promise.resolve({ gateways: 'new' });
    },
    setConnectionStatus: async () => {},
  };
  const app = { start: async (config) => started.push(config.gateways) };
  const onConnected = startOnConnect(gladys, app, undefined);
  const first = onConnected();
  await onConnected();
  late({ gateways: 'old' });
  await first;
  assert.deepEqual(started, ['new']);
});
