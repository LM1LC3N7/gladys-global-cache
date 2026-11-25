// -----------------------------------------------------------------------------
// /data: bounded reads (size, time, regular file only), an unreadable file is
// not an empty one, writes in order, the latest wins, only valid releases.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, MemoryStore, emptyData, releaseKey, sanitize } from '../src/store.js';
import { within } from './helpers/app.js';

async function dir(t) {
  const path = await mkdtemp(join(tmpdir(), 'global-cache-store-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('missing: empty; garbage, too large, a FIFO, a link: unreadable, within the bound', async (t) => {
  const path = await dir(t);
  const store = new FileStore({ dir: path });
  assert.equal((await store.load()).state, 'empty');
  await writeFile(store.path, '{not json');
  assert.equal((await store.load()).state, 'unreadable');
  await writeFile(store.path, 'x'.repeat(70 * 1024));
  assert.equal((await store.load()).state, 'unreadable');
  await rm(store.path);
  execFileSync('mkfifo', [store.path]);
  const started = Date.now();
  assert.equal((await within(store.load(), 5000, 'FIFO load')).state, 'unreadable');
  assert.ok(Date.now() - started < 3000);
  const writer = await open(store.path, constants.O_RDWR | constants.O_NONBLOCK);
  t.after(() => writer.close().catch(() => {}));
  await writer.write(JSON.stringify(emptyData()));
  assert.equal((await within(store.load(), 5000, 'FIFO load')).state, 'unreadable');
  await writer.close();
  await rm(store.path);
  await writeFile(join(path, 'real.json'), JSON.stringify(emptyData()));
  await symlink(join(path, 'real.json'), store.path);
  assert.equal((await store.load()).state, 'unreadable', 'a symbolic link is not followed');
});

test('round trip; the latest write wins', async (t) => {
  const path = await dir(t);
  const store = new FileStore({ dir: path });
  const data = emptyData();
  data.releases[releaseKey('192.168.1.70', 1, 2)] = { host: '192.168.1.70', m: 1, p: 2, at: 1000 };
  const a = store.save(emptyData());
  const b = store.save(data);
  const c = store.save(data);
  assert.deepEqual(await Promise.all([a, b, c]), [true, true, true]);
  const loaded = await store.load();
  assert.equal(loaded.state, 'ok');
  assert.deepEqual(loaded.data, data);
  assert.match(await readFile(store.path, 'utf8'), /192\.168\.1\.70/);
});

test('sanitize: only releases of valid addresses and ports, keyed right; future dates are now', () => {
  const good = { host: '192.168.1.70', m: 1, p: 2, at: 5 };
  const clean = sanitize(
    {
      releases: {
        [releaseKey('192.168.1.70', 1, 2)]: good,
        [releaseKey('192.168.1.70', 1, 3)]: { ...good, p: 3, at: 9e15 },
        wrongkey: { ...good, p: 4 },
        [releaseKey('bad host', 1, 2)]: { ...good, host: 'bad host' },
        [releaseKey('192.168.1.70', 1, 9)]: { ...good, p: 9 },
        [releaseKey('192.168.1.70', 1, 1)]: { ...good, p: 1, m: '1' },
        __proto__: good,
      },
      extra: 1,
    },
    1000,
  );
  assert.deepEqual(Object.keys(clean.releases).sort(), [
    releaseKey('192.168.1.70', 1, 2),
    releaseKey('192.168.1.70', 1, 3),
  ]);
  assert.equal(clean.releases[releaseKey('192.168.1.70', 1, 3)].at, 1000);
  assert.equal(clean.extra, undefined);
  assert.deepEqual(sanitize(null), emptyData());
});

test('memory store: failures on demand', async () => {
  const store = new MemoryStore();
  store.failing = true;
  assert.equal(await store.save(emptyData()), false);
  assert.equal(
    (await new MemoryStore(undefined, { state: 'unreadable' }).load()).state,
    'unreadable',
  );
});

test('a disk that never answers: unreadable within the bound, never awaited for ever', async (t) => {
  const path = await dir(t);
  const store = new FileStore({ dir: path, openFile: () => new Promise(() => {}) });
  const started = Date.now();
  assert.equal((await within(store.load(), 5000, 'stuck load')).state, 'unreadable');
  assert.ok(Date.now() - started < 3000);
});
