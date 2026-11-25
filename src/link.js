// -----------------------------------------------------------------------------
// One TCP connection to a gateway (port 4998), for one job: opened, a few
// requests one at a time (never pipelined: the GC-100 serves a single
// connection and every product line answers in order), then closed. Lines are
// bounded (LIMITS.line, LIMITS.buffer): a gateway that floods is cut before
// its answer is read whole. Every wait is bounded.
//
// `ask()` rejects with a LinkError whose `sent` says whether the request left
// (false: nothing was written; true: written, its outcome unknown or refused).
// -----------------------------------------------------------------------------

import net from 'node:net';
import { LIMITS } from './constants.js';
import { parseError } from './protocol.js';

export class LinkError extends Error {
  /**
   * kind: 'unreachable' | 'timeout' | 'device' (an error line, `code`) |
   * 'closed' | 'cut' | 'flood' | 'notSent' (beforeSend said no, `reason`)
   */
  constructor(kind, { sent = false, code, reason } = {}) {
    super(kind === 'device' ? `device error ${code}` : kind);
    this.kind = kind;
    this.sent = sent;
    this.code = code;
    this.reason = reason;
  }
}

export class Link {
  constructor({ host, timers, monotonic, connect = net.connect, timings }) {
    this.host = host;
    this.timers = timers;
    this.monotonic = monotonic;
    this.connectFn = connect;
    this.timings = timings;
    this.socket = undefined;
    this.buffer = '';
    this.lines = [];
    this.waiter = undefined;
    this.closed = false;
    this.closedPromise = Promise.resolve();
    this.lastByte = 0;
    this.bytesIn = 0;
    this.failure = undefined;
  }

  /** Opens the connection within `ms`. */
  open(ms = this.timings.connectTimeout) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = this.connectFn({ host: this.host.address, port: this.host.port });
      this.socket = socket;
      socket.setNoDelay?.(true);
      let markClosed;
      this.closedPromise = new Promise((r) => (markClosed = r));
      const timer = this.timers.setTimeout(() => {
        if (settled) return;
        settled = true;
        this.destroy();
        reject(new LinkError('unreachable'));
      }, ms);
      socket.once('connect', () => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timer);
        this.lastByte = this.monotonic();
        resolve();
      });
      socket.on('data', (chunk) => this.onData(chunk));
      socket.on('error', () => {});
      socket.once('close', () => {
        this.closed = true;
        markClosed();
        if (!settled) {
          settled = true;
          this.timers.clearTimeout(timer);
          reject(new LinkError('unreachable'));
        }
        this.fail(this.failure ?? new LinkError('closed', { sent: true }));
      });
    });
  }

  onData(chunk) {
    this.lastByte = this.monotonic();
    this.bytesIn += chunk.length;
    this.buffer += chunk.toString('latin1');
    const parts = this.buffer.split(/\r\n|\r|\n/);
    this.buffer = parts.pop();
    if (this.buffer.length > LIMITS.line || parts.some((l) => l.length > LIMITS.line)) {
      this.failure = new LinkError('flood', { sent: true });
      this.destroy();
      return;
    }
    for (const line of parts) {
      if (line === '') continue;
      this.lines.push(line);
      if (this.lines.length > LIMITS.linesPerRequest) {
        this.failure = new LinkError('flood', { sent: true });
        this.destroy();
        return;
      }
    }
    this.pump();
  }

  pump() {
    const waiter = this.waiter;
    if (!waiter) {
      // Lines nobody asked for (a notification): dropped, bounded.
      if (this.lines.length > LIMITS.linesPerRequest) this.lines = [];
      return;
    }
    while (this.lines.length && this.waiter === waiter) {
      const line = this.lines.shift();
      waiter.seen += 1;
      if (waiter.seen > LIMITS.linesPerRequest) {
        this.failure = new LinkError('flood', { sent: true });
        this.destroy();
        return;
      }
      const error = parseError(line);
      if (error) {
        this.settle(waiter, new LinkError('device', { sent: true, code: error.code }));
        return;
      }
      const verdict = waiter.match(line, waiter.collected);
      if (verdict === 'more') waiter.collected.push(line);
      else if (verdict === 'done') {
        waiter.collected.push(line);
        this.settle(waiter, undefined, waiter.collected);
        return;
      }
      // 'ignore': another port's notification, a stray line.
    }
  }

  settle(waiter, error, value) {
    if (this.waiter !== waiter) return;
    this.waiter = undefined;
    this.timers.clearTimeout(waiter.timer);
    if (error) waiter.reject(error);
    else waiter.resolve(value);
  }

  fail(error) {
    if (this.waiter) this.settle(this.waiter, error);
  }

  /**
   * Writes `line` + CR and resolves with the lines of its answer.
   * `match(line, collected)` -> 'done' | 'more' | 'ignore'.
   * `beforeSend()`, run right before the first byte, may throw to send nothing.
   */
  ask(line, match, { timeout = this.timings.answerTimeout, beforeSend } = {}) {
    if (this.waiter) return Promise.reject(new LinkError('notSent', { reason: 'busy' }));
    if (this.closed || !this.socket || this.socket.destroyed) {
      return Promise.reject(this.failure ?? new LinkError('closed'));
    }
    return new Promise((resolve, reject) => {
      if (beforeSend) {
        try {
          beforeSend();
        } catch (err) {
          reject(err instanceof LinkError ? err : new LinkError('notSent', { reason: err }));
          return;
        }
      }
      // Lines received before this request belong to nobody.
      this.lines = [];
      const waiter = { match, resolve, reject, collected: [], seen: 0 };
      waiter.timer = this.timers.setTimeout(
        () => this.settle(waiter, new LinkError('timeout', { sent: true })),
        Math.max(1, timeout),
      );
      this.waiter = waiter;
      this.lastByte = this.monotonic();
      this.socket.write(`${line}\r`);
    });
  }

  /** True when a request waits and the gateway said nothing for `ms`. */
  silentFor(ms) {
    return this.waiter !== undefined && this.monotonic() - this.lastByte >= ms;
  }

  /** Cuts the connection; the request under way rejects with `cut`. */
  cut() {
    this.failure = new LinkError('cut', { sent: true });
    this.destroy();
  }

  destroy() {
    this.socket?.destroy();
  }

  /** Closes and waits (bounded) for the end of the connection. */
  async close(ms = this.timings.closeWait) {
    if (!this.socket) return;
    this.socket.destroy();
    if (this.closed) return;
    let timer;
    await Promise.race([
      this.closedPromise,
      new Promise((resolve) => (timer = this.timers.setTimeout(resolve, ms))),
    ]);
    this.timers.clearTimeout(timer);
  }
}

// --- the answers of each request ---------------------------------------------

/** state,<m>:<p>,<0|1|2> for that port; `want`: the value the request set. */
export const stateOf =
  ({ m, p }, want) =>
  (line) => {
    const match = /^state,(\d):(\d),([0-2])$/.exec(line);
    if (!match || Number(match[1]) !== m || Number(match[2]) !== p) return 'ignore';
    if (want !== undefined && Number(match[3]) !== want) return 'ignore';
    return 'done';
  };

export const readState = (lines) => Number(/,([0-2])$/.exec(lines.at(-1))[1]);

/** device lines up to endlistdevices. */
export const devicesAnswer = (line, collected) => {
  if (line === 'endlistdevices') return 'done';
  if (/^device,\d,\d [A-Z0-9_:]{2,32}$/.test(line)) {
    return collected.length >= LIMITS.deviceLines ? 'ignore' : 'more';
  }
  return 'ignore';
};

export const versionAnswer = (line) =>
  /^version,0,/.test(line) || /^710-\d{4}-/.test(line) ? 'done' : 'ignore';

export const irModeOf =
  ({ m }) =>
  (line) => {
    const match = /^IR,(\d):(\d),([A-Z0-9_]{1,24})$/.exec(line);
    // Flex answers another port number (the cable, not a port).
    return match && Number(match[1]) === m ? 'done' : 'ignore';
  };

export const relayTypeOf =
  ({ m, p }) =>
  (line) => {
    const match = /^RELAY,(\d):(\d),([A-Za-z]{1,16})$/.exec(line);
    return match && Number(match[1]) === m && Number(match[2]) === p ? 'done' : 'ignore';
  };

export const completeOf =
  ({ m, p }, id) =>
  (line) =>
    line === `completeir,${m}:${p},${id}` ? 'done' : 'ignore';
