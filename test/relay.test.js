// -----------------------------------------------------------------------------
// Relays: the pulse (sensitive, off by default) and the release (protective,
// never refused). Fake gateways on real sockets, virtual clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, emptyData, releaseKey } from '../src/store.js';
import { startFakeGc } from './helpers/fakeGc.js';
import { D, F, createAll, press, setup, sleep, until, within } from './helpers/app.js';

const PULSE = 'relay-1-1-pulse';
const RELEASE = 'relay-1-1-release';

async function ready(t, options = {}) {
  const s = await setup(t, options);
  await s.ready();
  await createAll(s.gladys);
  return s;
}

const sent = (fake, prefix) => fake.requests(prefix).length;

test('a pulse: identity, port and state read again, /data written, then 1, released after its length', async (t) => {
  const s = await ready(t);
  const before = s.fake.lines.length;
  let keptAtFirstByte;
  s.fake.hooks.push((line) => {
    if (line === 'setstate,1:1,1') keptAtFirstByte = Object.keys(s.store.data.releases);
    return undefined;
  });
  const ack = await press(s.gladys, s.fake.host, PULSE);
  assert.equal(ack.success, true, ack.error);
  const lines = s.fake.lines.slice(before).map((l) => l.line);
  assert.deepEqual(lines, ['getversion', 'getdevices', 'getstate,1:1', 'setstate,1:1,1']);
  assert.deepEqual(keptAtFirstByte, [releaseKey(s.fake.host, 1, 1)]);
  assert.equal(s.fake.state.relays.get('1:1'), 1);
  await s.step(400);
  assert.equal(s.fake.state.relays.get('1:1'), 1, 'not released before its length');
  await s.step(100);
  await until(() => s.fake.state.relays.get('1:1') === 0);
  await until(() => Object.keys(s.store.data.releases).length === 0);
  assert.deepEqual(
    s.fake.history.map((h) => h.value),
    [1, 0],
  );
  // The release is confirmed by a reading made after it.
  assert.equal(s.fake.lines.at(-1).line, 'getstate,1:1');
});

test('relays off by default: refused, nothing sent; the release still goes', async (t) => {
  const s = await ready(t, { config: { allow_relays: undefined } });
  const connections = s.fake.connections;
  const ack = await press(s.gladys, s.fake.host, PULSE);
  assert.equal(s.fake.connections, connections, 'refused before any exchange');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Autoriser les relais/);
  assert.equal(sent(s.fake, 'setstate'), 0);
  const release = await press(s.gladys, s.fake.host, RELEASE);
  assert.equal(release.success, true, release.error);
  assert.deepEqual(s.fake.requests('setstate'), ['setstate,1:1,0']);
});

test('the option unchecked between the reads and the first byte: nothing sent, /data cleared', async (t) => {
  const s = await ready(t);
  s.fake.hooks.push((line) => {
    if (line === 'getstate,1:1') s.app.config = { ...s.app.config, allowRelays: false };
    return undefined;
  });
  const ack = await press(s.gladys, s.fake.host, PULSE);
  assert.equal(ack.success, false);
  assert.equal(sent(s.fake, 'setstate'), 0);
  await until(() => Object.keys(s.store.data.releases).length === 0);
  assert.equal(s.app.gateways.values().next().value.holds.size, 0);
});

test('/data not written, stuck, or unreadable: the pulse is refused, nothing sent', async (t) => {
  const s = await ready(t);
  s.store.failing = true;
  let ack = await press(s.gladys, s.fake.host, PULSE);
  assert.equal(ack.success, false);
  assert.match(ack.error, /\/data/);
  s.store.failing = false;
  let free;
  s.store.stuck = new Promise((resolve) => (free = resolve));
  const pending = press(s.gladys, s.fake.host, PULSE);
  await s.advanceUntil(() => s.app.gateways.values().next().value.current === undefined, {
    ms: 5000,
  });
  ack = await pending;
  assert.equal(ack.success, false);
  free();
  assert.equal(sent(s.fake, 'setstate'), 0);
  s.app.storeState = 'unreadable';
  ack = await press(s.gladys, s.fake.host, PULSE);
  assert.equal(ack.success, false);
  assert.match(ack.error, /illisible/);
  assert.equal(sent(s.fake, 'setstate'), 0);
});

test('a relay read closed, another model, a port that is no relay, no created device: refused, nothing sent', async (t) => {
  const s = await ready(t);
  s.fake.state.relays.set('1:1', 1);
  let ack = await press(s.gladys, s.fake.host, PULSE);
  assert.match(ack.error, /lu fermé/);
  s.fake.state.relays.set('1:1', 0);
  ack = await press(s.gladys, s.fake.host, 'relay-1-4-pulse');
  assert.match(ack.error, /plus un relais/);
  s.fake.version = '710-1005-05';
  ack = await press(s.gladys, s.fake.host, PULSE);
  assert.match(ack.error, /IP2IR répond à la place/);
  s.fake.version = '710-1008-05';
  s.gladys.fake.devices = [];
  await s.gladys.getDevices();
  ack = await press(s.gladys, s.fake.host, PULSE);
  assert.match(ack.error, /pas encore créée/);
  assert.equal(sent(s.fake, 'setstate'), 0);
});

test('an unreadable identity is not another device: refused as unexpected, nothing sent', async (t) => {
  const s = await ready(t);
  s.fake.mute.add('getversion');
  const pending = press(s.gladys, s.fake.host, PULSE);
  await s.advanceUntil(() => s.app.gateways.values().next().value.current === undefined, {
    ms: 5000,
  });
  const ack = await pending;
  assert.match(ack.error, /inattendue/);
  assert.equal(sent(s.fake, 'setstate'), 0);
  assert.equal(s.app.gateways.values().next().value.state, 'ok');
});

test('a release while the pulse is held: opened at once, the timer does nothing more', async (t) => {
  const s = await ready(t);
  assert.equal((await press(s.gladys, s.fake.host, PULSE)).success, true);
  const ack = await press(s.gladys, s.fake.host, RELEASE);
  assert.equal(ack.success, true, ack.error);
  assert.equal(s.fake.state.relays.get('1:1'), 0);
  await s.step(2000);
  await sleep(20);
  assert.deepEqual(
    s.fake.history.map((h) => h.value),
    [1, 0],
  );
});

test('a pulse waiting behind a command is cancelled by a release; the release cuts a silent command after 1 s', async (t) => {
  const s = await ready(t, { model: 'GC100' });
  const host = s.fake.host;
  // A long IR transmission occupies the single connection of the GC-100.
  s.fake.irMs = 60_000;
  const ir = s.gladys.fake.sceneAction('send_ir', {
    device: D(host),
    connector: '4:1',
    // 4 s of transmission: its answer is due after 5.5 s, the release cuts it after 1 s.
    code: '40000,1,1,50000,50000,50000,10000',
  });
  await s.advanceUntil(() => sent(s.fake, 'sendir') === 1, { ms: 1000, every: 50 });
  const pulse = press(s.gladys, host, 'relay-3-1-pulse');
  await until(() => s.app.gateways.values().next().value.queue.length === 1);
  const release = press(s.gladys, host, 'relay-3-1-release');
  const ackPulse = await pulse;
  assert.equal(ackPulse.success, false);
  assert.match(ackPulse.error, /Relâchement demandé/);
  await s.step(500);
  assert.equal(sent(s.fake, 'setstate'), 0, 'the command is not cut before 1 s of silence');
  await s.advanceUntil(() => sent(s.fake, 'setstate') === 1, { ms: 3000, every: 100 });
  const ack = await release;
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(s.fake.requests('setstate'), ['setstate,3:1,0']);
  const outcome = await within(ir, 5000, 'ir');
  assert.equal(outcome.success, true);
  assert.equal(outcome.data.outputs.confirmed, false);
  // The cancelled pulse never runs: the relay is read by the first reading and the release only.
  await s.advanceUntil(() => !s.app.gateways.values().next().value.busy, { ms: 3000, every: 50 });
  assert.equal(s.fake.requests('getstate,3:1').length, 2);
  assert.ok(s.fake.peak <= 1, 'one connection at a time');
});

test('a release cuts a reading at once (no answer timeout needed)', async (t) => {
  const s = await ready(t);
  s.fake.mute.add('getstate,1:2');
  await s.step(30_000);
  await until(
    () =>
      s.app.gateways.values().next().value.current?.kind === 'read' &&
      sent(s.fake, 'getstate,1:2') >= 2,
  );
  const ack = await press(s.gladys, s.fake.host, RELEASE);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(s.fake.requests('setstate'), ['setstate,1:1,0']);
});

test('a pulse sent without answer: "sent, without confirmation", the release still follows', async (t) => {
  const s = await ready(t);
  s.fake.mute.add('setstate,1:1,1');
  s.fake.hooks.push((line) => {
    if (line === 'setstate,1:1,1') s.fake.state.relays.set('1:1', 1);
    return undefined;
  });
  const pending = press(s.gladys, s.fake.host, PULSE);
  await s.advanceUntil(() => s.app.gateways.values().next().value.current === undefined, {
    ms: 5000,
    every: 100,
  });
  const ack = await pending;
  assert.equal(ack.success, true);
  assert.match(ack.data, /sans confirmation/);
  await s.advanceUntil(() => s.fake.state.relays.get('1:1') === 0, { ms: 3000 });
});

test('the gateway unreachable at release time: kept in /data, sent again by 3 readings at most', async (t) => {
  const s = await ready(t);
  assert.equal((await press(s.gladys, s.fake.host, PULSE)).success, true);
  s.fake.silent = true;
  await s.advanceUntil(() => s.app.gateways.values().next().value.holds.size === 0, { ms: 2000 });
  await s.advanceUntil(() => !s.app.gateways.values().next().value.busy, { ms: 10_000 });
  assert.deepEqual(Object.keys(s.store.data.releases), [releaseKey(s.fake.host, 1, 1)]);
  assert.match(s.app.statusLine(s.app.gateways.values().next().value).fr, /relâchement/);
  // The gateway answers getversion etc. but ignores the release: three tries by readings.
  s.fake.silent = false;
  s.fake.mute.add('setstate,1:1,0');
  const before = sent(s.fake, 'setstate,1:1,0');
  for (let i = 0; i < 6; i += 1) {
    await s.step(30_000);
    await s.advanceUntil(() => !s.app.gateways.values().next().value.busy, { ms: 10_000 });
  }
  // One release per reading (its budget is spent by its first timeout), 3 readings only.
  assert.equal(sent(s.fake, 'setstate,1:1,0') - before, 3);
  // Answering again: the next reading after a restart of the tries releases it.
  s.fake.mute.clear();
  s.app.releaseTries.clear();
  await s.step(30_000);
  await s.advanceUntil(() => !s.app.gateways.values().next().value.busy, { ms: 10_000 });
  await until(() => Object.keys(s.store.data.releases).length === 0);
  assert.equal(s.fake.state.relays.get('1:1'), 0);
});

test('restart: a release kept in /data is sent before the configuration is read', async (t) => {
  const fake = await startFakeGc('IP2CC');
  fake.state.relays.set('1:2', 1);
  const data = emptyData();
  data.releases[releaseKey(fake.host, 1, 2)] = { host: fake.host, m: 1, p: 2, at: 1 };
  const store = new MemoryStore(data);
  const s = await setup(t, { fakes: [fake], store, start: false });
  s.gladys.getConfig = () => Promise.reject(new Error('Gladys down'));
  await within(s.app.boot(), 3000, 'boot');
  await until(() => fake.state.relays.get('1:2') === 0);
  await until(() => Object.keys(store.data.releases).length === 0);
  assert.deepEqual(fake.requests('setstate'), ['setstate,1:2,0']);
});

test('the release button works before the configuration is read (address from the device)', async (t) => {
  const first = await ready(t);
  const device = first.gladys.fake.devices[0];
  const s = await setup(t, { fakes: [first.fake], start: false, devices: [device] });
  const ack = await within(
    s.gladys.fake.setValue(device, { external_id: F(first.fake.host, 'relay-1-3-release') }, 1),
    5000,
  );
  assert.equal(ack.success, true, ack.error);
  assert.ok(first.fake.requests('setstate').includes('setstate,1:3,0'));
});

test('stopping during a pulse releases the relay', async (t) => {
  const s = await ready(t);
  assert.equal((await press(s.gladys, s.fake.host, PULSE)).success, true);
  await within(s.app.stop(), 3000, 'stop');
  assert.equal(s.fake.state.relays.get('1:1'), 0);
});

test('a pulse refused by the gateway: the error, and the release is sent anyway', async (t) => {
  const s = await ready(t);
  s.fake.hooks.push((line) => (line === 'setstate,1:1,1' ? 'ERR_1:1,005' : undefined));
  const ack = await press(s.gladys, s.fake.host, PULSE);
  assert.equal(ack.success, false);
  assert.match(ack.error, /erreur 005/);
  await s.advanceUntil(() => sent(s.fake, 'setstate,1:1,0') === 1, { ms: 2000 });
});

test('a second pulse on a held relay, a read-only feature, a bad value: refused', async (t) => {
  const s = await ready(t);
  assert.equal((await press(s.gladys, s.fake.host, PULSE)).success, true);
  assert.match((await press(s.gladys, s.fake.host, PULSE)).error, /encore fermé/);
  assert.match((await press(s.gladys, s.fake.host, 'relay-1-1-state')).error, /lit seulement/);
  assert.match((await press(s.gladys, s.fake.host, PULSE, 0)).error, /inattendue/);
  assert.equal(sent(s.fake, 'setstate,1:1,1'), 1);
});

test('GC-100: readings and pulses never open a second connection', async (t) => {
  const s = await ready(t, { model: 'GC100' });
  for (let i = 0; i < 3; i += 1) {
    const pending = press(s.gladys, s.fake.host, 'relay-3-2-pulse');
    await s.advanceUntil(() => s.fake.state.relays.get('3:2') === 1, { ms: 2000, every: 50 });
    assert.equal((await pending).success, true);
    await s.advanceUntil(() => s.fake.state.relays.get('3:2') === 0, { ms: 3000 });
  }
  assert.equal(s.fake.peak, 1);
});

test('the budget runs out while /data is written: nothing sent, the guard removed', async (t) => {
  const s = await ready(t);
  const save = s.store.save.bind(s.store);
  s.store.save = async (data) => {
    // The disk takes 3.2 s of the 3.3 s budget (virtual clock), then succeeds.
    if (Object.keys(data.releases).length) s.clock.now += 3200;
    return save(data);
  };
  const ack = await press(s.gladys, s.fake.host, PULSE);
  assert.equal(ack.success, false);
  assert.match(ack.error, /trop lente/);
  assert.equal(sent(s.fake, 'setstate'), 0);
  await until(() => Object.keys(s.store.data.releases).length === 0);
  assert.equal(s.app.gateways.values().next().value.holds.size, 0);
});

test('a full queue refuses pulses and IR codes, never the release', async (t) => {
  const s = await ready(t, { model: 'GC100' });
  const host = s.fake.host;
  s.fake.irMs = 60_000;
  const ir = (port) =>
    s.gladys.fake.sceneAction('send_ir', {
      device: D(host),
      connector: port,
      code: '40000,1,1,100,100',
    });
  const first = ir('4:1');
  await s.advanceUntil(() => sent(s.fake, 'sendir') === 1, { ms: 1000, every: 50 });
  const waiting = [];
  for (let i = 0; i < 8; i += 1) waiting.push(ir('4:2'));
  await until(() => s.app.gateways.values().next().value.queue.length === 8);
  const ninth = await within(ir('5:1'), 3000);
  assert.match(ninth.error, /Trop de commandes/);
  const pulse = await press(s.gladys, host, 'relay-3-1-pulse');
  assert.match(pulse.error, /Trop de commandes/);
  const release = press(s.gladys, host, 'relay-3-1-release');
  await s.advanceUntil(() => sent(s.fake, 'setstate,3:1,0') === 1, { ms: 3000, every: 100 });
  assert.equal((await release).success, true);
  s.app.gateways.values().next().value.stop();
  await Promise.allSettled([first, ...waiting]);
});

test('a release asked while the pulse reads (before its first byte): the pulse never leaves', async (t) => {
  const s = await ready(t);
  let release;
  s.fake.hooks.push((line) => {
    if (line === 'getstate,1:1' && !release) release = press(s.gladys, s.fake.host, RELEASE);
    return undefined;
  });
  const ack = await press(s.gladys, s.fake.host, PULSE);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Relâchement demandé/);
  assert.equal((await release).success, true);
  assert.deepEqual(s.fake.requests('setstate'), ['setstate,1:1,0']);
  await until(() => Object.keys(s.store.data.releases).length === 0);
});

test('GC-100: a pulse on an input port (not a relay) is refused, nothing sent', async (t) => {
  const s = await ready(t, { model: 'GC100' });
  const pending = press(s.gladys, s.fake.host, 'relay-4-3-pulse');
  await s.advanceUntil(() => !s.app.gateways.values().next().value.busy, { ms: 3000, every: 50 });
  const ack = await pending;
  assert.match(ack.error, /plus un relais/);
  assert.equal(sent(s.fake, 'setstate'), 0);
});

test('a relay still read closed after its release: not confirmed, kept in /data', async (t) => {
  const s = await ready(t);
  s.fake.hooks.push((line) => (line === 'getstate,1:3' ? 'state,1:3,1' : undefined));
  const pending = press(s.gladys, s.fake.host, 'relay-1-3-release');
  await s.advanceUntil(() => !s.app.gateways.values().next().value.busy, { ms: 3000, every: 50 });
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ack.error, /sans confirmation/);
  await until(() => Object.keys(s.store.data.releases).length === 1);
});

test('a release of a relay never pulsed, gateway silent: kept in /data all the same', async (t) => {
  const s = await ready(t);
  s.fake.silent = true;
  const pending = press(s.gladys, s.fake.host, 'relay-1-2-release');
  await s.advanceUntil(() => !s.app.gateways.values().next().value.busy, { ms: 5000, every: 50 });
  assert.equal((await pending).success, false);
  await until(() => Object.keys(s.store.data.releases).length === 1);
  assert.equal(Object.values(s.store.data.releases)[0].p, 2);
});
