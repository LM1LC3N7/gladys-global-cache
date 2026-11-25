// -----------------------------------------------------------------------------
// IR codes from scenes and from the Configuration screen: checked before
// anything leaves, port mode read again, end of transmission awaited.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startFakeGc } from './helpers/fakeGc.js';
import { D, DEAD_PORT, createAll, setup, until, within } from './helpers/app.js';

const CODE = '38000,1,1,342,171,21,21,21,64,21,1520';

async function ready(t, options = { model: 'IP2IR' }) {
  const s = await setup(t, options);
  for (let i = 0; i < s.fakes.length; i += 1) await s.ready(i);
  await createAll(s.gladys);
  return s;
}

const scene = (s, fields, fake = s.fake) =>
  within(s.gladys.fake.sceneAction('send_ir', { device: D(fake.host), ...fields }), 8000, 'scene');

test('a scene sends the code with our own ID and waits for completeir', async (t) => {
  const s = await ready(t);
  const ack = await scene(s, { connector: '1:1', code: `sendir,1:1,999,${CODE}` });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.outputs, { confirmed: true });
  const [line] = s.fake.requests('sendir');
  assert.match(line, /^sendir,1:1,\d{1,5},38000,1,1,342,171/);
  assert.ok(!line.includes(',999,'));
  // The port mode was read again on the same connection, right before.
  const lines = s.fake.lines.map((l) => l.line);
  assert.equal(lines[lines.indexOf(line) - 1], 'get_IR,1:1');
});

test('the connector comes from the sendir line; a mismatch, a missing one, a sensor port: refused', async (t) => {
  const s = await ready(t);
  let ack = await scene(s, { code: `sendir,1:3,1,${CODE}` });
  assert.equal(ack.success, true, ack.error);
  ack = await scene(s, { connector: '1:1', code: `sendir,1:3,1,${CODE}` });
  assert.match(ack.error, /diffère/);
  ack = await scene(s, { code: CODE });
  assert.match(ack.error, /Indiquez le connecteur/);
  ack = await scene(s, { connector: '1:2', code: CODE });
  assert.match(ack.error, /réglé en SENSOR/);
  ack = await scene(s, { connector: '2:1', code: CODE });
  assert.match(ack.error, /pas une sortie infrarouge/);
  ack = await scene(s, { connector: 'x', code: CODE });
  assert.match(ack.error, /pas une sortie infrarouge/);
  assert.equal(s.fake.requests('sendir').length, 1);
});

test('a bad code is refused before any connection, and never shown back', async (t) => {
  const s = await ready(t);
  const before = s.fake.connections;
  const ack = await scene(s, { connector: '1:1', code: 'sendir,1:1,1,40000,1,1,4,5A8,9ABB' });
  assert.match(ack.error, /compressé/);
  assert.ok(!ack.error.includes('5A8'));
  assert.equal(s.fake.connections, before);
});

test('Pronto codes are sent converted', async (t) => {
  const s = await ready(t);
  const ack = await scene(s, { connector: '1:1', code: '0000 006D 0000 0002 0010 0010 0010 0BB8' });
  assert.equal(ack.success, true, ack.error);
  assert.match(s.fake.requests('sendir')[0], /^sendir,1:1,\d+,38029,1,1,16,16,16,3000$/);
});

test('a busy port, an error: refused; no completeir: sent without confirmation', async (t) => {
  const s = await ready(t);
  s.fake.hooks.push((line) => (line.startsWith('sendir,1:1,') ? 'busyIR,1:1,1' : undefined));
  let ack = await scene(s, { connector: '1:1', code: CODE });
  assert.match(ack.error, /occupé/);
  s.fake.hooks = [(line) => (line.startsWith('sendir,1:1,') ? 'ERR_1:1,005' : undefined)];
  ack = await scene(s, { connector: '1:1', code: CODE });
  assert.match(ack.error, /erreur 005/);
  s.fake.hooks = [];
  s.fake.mute.add('sendir');
  const pending = scene(s, { connector: '1:1', code: CODE });
  await s.advanceUntil(() => !s.app.gateways.values().next().value.current, { ms: 5000 });
  ack = await pending;
  assert.equal(ack.success, true);
  assert.deepEqual(ack.data.outputs, { confirmed: false });
});

test('GC-100: under 20 kHz refused before sending; the button of the Configuration screen works', async (t) => {
  const s = await ready(t, { model: 'GC100' });
  const first = scene(s, { connector: '4:1', code: '19000,1,1,10,10' });
  await s.advanceUntil(() => !s.app.gateways.values().next().value.busy, { ms: 2000, every: 50 });
  let ack = await first;
  assert.match(ack.error, /20 000/);
  assert.equal(s.fake.requests('sendir').length, 0);
  const pending = within(
    s.gladys.fake.action('send_ir', { device: D(s.fake.host), connector: '4:2', code: CODE }),
    5000,
  );
  await s.advanceUntil(() => s.fake.requests('sendir').length === 1, { ms: 2000, every: 50 });
  ack = await pending;
  assert.equal(ack.success, true, ack.error);
  assert.match(ack.data.message.fr, /émis/);
});

test('an unreachable gateway: nothing sent; the other gateways are not held', async (t) => {
  const fakes = [await startFakeGc('IP2IR'), await startFakeGc('IP2IR')];
  // The first gateway goes away: its connections reach a port that refuses.
  let gone = false;
  const connect = (options) =>
    net.connect(gone && options.port === fakes[0].port ? { ...options, port: DEAD_PORT } : options);
  const s = await ready(t, { fakes, connect });
  gone = true;
  const pending = scene(s, { connector: '1:1', code: CODE }, fakes[0]);
  const other = await scene(s, { connector: '1:1', code: CODE }, fakes[1]);
  assert.equal(other.success, true, other.error);
  await s.advanceUntil(() => ![...s.app.gateways.values()][0].current, { ms: 5000, every: 50 });
  const ack = await pending;
  assert.match(ack.error, /injoignable, rien envoyé/);
});

test('a scene on 5 slow gateways (4 answers of 150 ms each): all 5 sent', async (t) => {
  const fakes = [];
  for (let i = 0; i < 5; i += 1) fakes.push(await startFakeGc('IP2IR', { latencyMs: 0 }));
  const s = await ready(t, { fakes });
  for (const f of fakes) f.latencyMs = 150;
  const acks = await within(
    Promise.all(fakes.map((f) => scene(s, { connector: '1:1', code: CODE }, f))),
    8000,
  );
  assert.ok(
    acks.every((a) => a.success && a.data.outputs.confirmed),
    JSON.stringify(acks),
  );
});

test('another model at the address: no code sent; ERR IR008 is a busy port', async (t) => {
  const s = await ready(t);
  s.fake.version = '710-1008-05';
  let ack = await scene(s, { connector: '1:1', code: CODE });
  assert.match(ack.error, /répond à la place/);
  assert.equal(s.fake.requests('sendir').length, 0);
  s.fake.version = '710-1005-05';
  s.fake.hooks.push((line) => (line.startsWith('sendir') ? 'ERR IR008' : undefined));
  ack = await scene(s, { connector: '1:1', code: CODE });
  assert.match(ack.error, /occupé/);
});

test('stopping while a code transmits: said sent without confirmation, not "nothing sent"', async (t) => {
  const s = await ready(t);
  s.fake.irMs = 60_000;
  const pending = scene(s, { connector: '1:1', code: '40000,1,1,50000,50000,50000,10000' });
  await until(() => s.fake.requests('sendir').length === 1);
  await within(s.app.stop(), 4000, 'stop');
  const ack = await pending;
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.outputs, { confirmed: false });
});
