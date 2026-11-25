// -----------------------------------------------------------------------------
// One connection: bounded lines, an error line is the answer, a request that
// beforeSend refuses never leaves, a flood is cut before it is read whole.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { TIMINGS } from '../src/constants.js';
import { Link, LinkError, stateOf, versionAnswer } from '../src/link.js';

async function server(t, onLine) {
  const received = [];
  const sockets = new Set();
  const srv = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let i;
      while ((i = buffer.indexOf('\r')) !== -1) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        received.push(line);
        onLine(line, socket);
      }
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const link = new Link({
    host: { address: '127.0.0.1', port: srv.address().port },
    timers: globalThis,
    monotonic: () => performance.now(),
    timings: TIMINGS,
  });
  t.after(async () => {
    await link.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => srv.close(resolve));
  });
  await link.open();
  return { link, received };
}

test('an error line answers the request; the request carries a CR', async (t) => {
  const { link, received } = await server(t, (line, socket) => socket.write('ERR_1:1,014\r'));
  await assert.rejects(
    link.ask('get_IR,1:1', versionAnswer),
    (err) => err.kind === 'device' && err.code === '014' && err.sent,
  );
  assert.deepEqual(received, ['get_IR,1:1']);
});

test('beforeSend refusing: nothing written', async (t) => {
  const { link, received } = await server(t, () => {});
  await assert.rejects(
    link.ask('setstate,1:1,1', stateOf({ m: 1, p: 1 }, 1), {
      beforeSend: () => {
        throw new Error('no');
      },
    }),
    (err) => err instanceof LinkError && err.kind === 'notSent' && !err.sent,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(received, []);
});

test('a line longer than 256 bytes, even split, is cut before its end', async (t) => {
  const { link } = await server(t, (line, socket) => {
    socket.write('7'.repeat(200));
    setTimeout(() => socket.write('7'.repeat(200)), 10);
  });
  await assert.rejects(link.ask('getversion', versionAnswer), (err) => err.kind === 'flood');
});

test('a stream of lines that are no answer is cut (64 lines at most)', async (t) => {
  const { link } = await server(t, (line, socket) => socket.write('state,9:9,0\r'.repeat(100)));
  await assert.rejects(link.ask('getversion', versionAnswer), (err) => err.kind === 'flood');
});

test('no answer: a timeout, said sent', async (t) => {
  const { link } = await server(t, () => {});
  await assert.rejects(
    link.ask('getversion', versionAnswer, { timeout: 50 }),
    (err) => err.kind === 'timeout' && err.sent,
  );
});
