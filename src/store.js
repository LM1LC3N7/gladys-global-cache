// -----------------------------------------------------------------------------
// What the integration keeps across restarts, in /data/global-cache.json (the
// one writable volume): the relay releases still owed. A pulse is written
// here BEFORE its first byte leaves (not written = not sent), and removed
// once the gateway answered the release and a reading showed the relay open.
// At start, every release kept here is sent at once, before the configuration
// is even read: a restart in the middle of a pulse never leaves a gate
// contact closed. Nothing secret: an address, a module and a port.
//
// Bounded: the file is read within TIMINGS.storeTimeout, at most
// LIMITS.storeBytes, and must be a regular file (a FIFO or a device is
// refused, never waited on). An unreadable file is not an empty one: it is
// never overwritten. Writes go one at a time, the latest data wins.
// -----------------------------------------------------------------------------

import { constants } from 'node:fs';
import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseHost } from './config.js';
import { LIMITS, TIMINGS } from './constants.js';
import { isObject, safeJson } from './json.js';

export const emptyData = () => ({ releases: {} });

export const releaseKey = (hostKey, m, p) => `${hostKey}|${m}:${p}`;

/** What a file holds, checked: unknown keys dropped, a date in the future is now. */
export function sanitize(data, now = Date.now()) {
  const base = emptyData();
  if (!isObject(data) || !isObject(data.releases)) return base;
  for (const [key, entry] of Object.entries(data.releases).slice(0, LIMITS.releases)) {
    if (!isObject(entry)) continue;
    const host = parseHost(entry.host);
    const { m, p } = entry;
    if (!host || host.key !== entry.host) continue;
    if (!Number.isInteger(m) || m < 0 || m > 9 || !Number.isInteger(p) || p < 1 || p > 8) continue;
    if (key !== releaseKey(host.key, m, p)) continue;
    const at = Number.isFinite(entry.at) && entry.at <= now ? entry.at : now;
    base.releases[key] = { host: host.key, m, p, at };
  }
  return base;
}

const withTimeout = (promise, ms, onLate) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onLate?.();
      reject(new Error('timeout'));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });

export class FileStore {
  constructor({
    dir = process.env.DATA_DIR || '/data',
    name = 'global-cache.json',
    now = Date.now,
    openFile = open,
    timeout = TIMINGS.storeTimeout,
  } = {}) {
    this.openFile = openFile;
    this.timeout = timeout;
    /** The read of the file under way (it may outlive the bound): one at a time. */
    this.reading = undefined;
    this.dir = dir;
    this.path = join(dir, name);
    this.now = now;
    this.chain = Promise.resolve();
    this.pending = undefined;
  }

  /**
   * -> { data, state: 'ok' | 'empty' | 'unreadable' } within the bound. A
   * read still under way (a stuck disk) is never doubled: unreadable at once.
   */
  async load() {
    if (this.reading) return { data: emptyData(), state: 'unreadable' };
    let handle;
    const read = async () => {
      // O_NONBLOCK: opening a FIFO never waits for a writer.
      handle = await this.openFile(
        this.path,
        constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
      );
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('not a regular file');
      if (stat.size > LIMITS.storeBytes) throw new Error('too large');
      const buffer = Buffer.alloc(LIMITS.storeBytes + 1);
      let bytesRead = 0;
      for (;;) {
        let n;
        try {
          ({ bytesRead: n } = await handle.read(
            buffer,
            bytesRead,
            buffer.length - bytesRead,
            null,
          ));
        } catch (err) {
          if (err?.code === 'EAGAIN') break; // nothing more for now
          throw err;
        }
        if (n === 0) break;
        bytesRead += n;
        if (bytesRead >= buffer.length) break;
      }
      if (bytesRead > LIMITS.storeBytes) throw new Error('too large');
      return buffer.subarray(0, bytesRead).toString('utf8');
    };
    try {
      const reading = read();
      this.reading = reading;
      // Its end (even after the bound) frees the slot and closes the file.
      const end = () => {
        this.clearReading(reading);
        handle?.close().catch(() => {});
      };
      reading.then(end, end);
      const text = await withTimeout(reading, this.timeout);
      return { data: sanitize(safeJson(text), this.now()), state: 'ok' };
    } catch (err) {
      if (err?.code === 'ENOENT') return { data: emptyData(), state: 'empty' };
      return { data: emptyData(), state: 'unreadable' };
    }
  }

  clearReading(reading) {
    if (this.reading === reading) this.reading = undefined;
  }

  /**
   * Writes `data` (a copy is taken now). Resolves true when written, false
   * otherwise; one write at a time, a later call replaces a waiting one.
   */
  save(data) {
    const text = JSON.stringify(data);
    const waiting = this.pending;
    this.pending = { text, resolvers: [] };
    const job = this.pending;
    if (waiting) {
      // The waiting write is replaced: its callers learn the outcome of this one.
      job.resolvers.push(...waiting.resolvers);
      waiting.replaced = true;
    }
    const result = new Promise((resolve) => job.resolvers.push(resolve));
    if (!waiting) {
      this.chain = this.chain.then(async () => {
        const current = this.pending;
        this.pending = undefined;
        let ok;
        try {
          await mkdir(this.dir, { recursive: true });
          const temporary = `${this.path}.${process.pid}.tmp`;
          await writeFile(temporary, current.text, { mode: 0o600 });
          await rename(temporary, this.path);
          ok = true;
        } catch {
          ok = false;
        }
        for (const resolve of current.resolvers) resolve(ok);
      });
    }
    return result;
  }
}

/** For the tests: in memory, with failures and delays on demand. */
export class MemoryStore {
  constructor(data = emptyData(), { state = 'ok', now = Date.now } = {}) {
    this.data = structuredClone(data);
    this.state = state;
    this.saves = 0;
    this.now = now;
    this.failing = false;
    /** A promise the next writes wait for (a stuck disk). */
    this.stuck = undefined;
  }

  async load() {
    if (this.state === 'unreadable') return { data: emptyData(), state: 'unreadable' };
    return { data: sanitize(structuredClone(this.data), this.now()), state: this.state };
  }

  async save(data) {
    if (this.stuck) await this.stuck;
    if (this.failing) return false;
    this.data = structuredClone(data);
    this.saves += 1;
    return true;
  }
}
