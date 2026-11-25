// -----------------------------------------------------------------------------
// One gateway (one address): its jobs, run one at a time, each on a connection
// of its own that is closed before the next one opens (the GC-100 serves one
// connection at a time; the gateway may also serve other apps).
//
//   - reading ('read'): identity (getversion), modules (getdevices), IR port
//     modes (get_IR), relay types (Flex), then the state of every relay and
//     input. Never doubled; cut by any command (it does not count as a
//     failure, the next one comes at the interval).
//   - command ('command'): a relay pulse, an IR code. Identity and port read
//     again on the same connection right before; nothing sent on a doubt.
//   - release ('release'): opening a relay contact. Protective: never
//     refused, ahead of everything, it cancels the pulses waiting and cuts a
//     reading at once, a command that said nothing for 1 s.
//
// A pulse: the relay read open right before, the coming release written in
// /data (awaited; not written = nothing sent), the option read again right
// before the first byte, then setstate 1; the release follows after the pulse
// length (timer started at the first byte, whatever the answer).
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';
import { T } from './i18n.js';
import {
  Link,
  LinkError,
  completeOf,
  devicesAnswer,
  irModeOf,
  readState,
  relayTypeOf,
  stateOf,
  versionAnswer,
} from './link.js';
import {
  IR_TYPES,
  familyLimit,
  irDuration,
  parseDeviceLine,
  parseVersion,
  sendirLine,
} from './protocol.js';

export class CommandError extends Error {
  /** `sent`: false when nothing left (the text says so). */
  constructor(text, { sent = false, kind } = {}) {
    super(text.en);
    this.text = text;
    this.sent = sent;
    /** The link failure behind it (a retry needs it), if any. */
    this.kind = kind;
  }
}

const notSent = (text) => {
  throw new CommandError(text);
};

/** IR port modes that emit (get_IR, section 4.4.1). */
const EMITTING = new Set([
  'IR',
  'BL2_BLASTER',
  'IR_NOCARRIER',
  'IR_BLASTER',
  'IRTRIPORT',
  'IRTRIPORT_BLASTER',
]);
const SENSING = new Set(['SENSOR', 'SENSOR_NOTIFY']);

/** Requests of one reading, at most (identity, modules, modes, states). */
const READ_REQUESTS = 48;

export class Gateway {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    /** 'starting' | 'ok' | 'down' | 'answer' | 'other' */
    this.state = 'starting';
    this.info = undefined;
    this.queue = [];
    this.current = undefined;
    this.polling = false;
    this.pollTimer = undefined;
    this.lastTick = undefined;
    this.lastRead = undefined;
    this.stopped = false;
    /** Relay -> timer of its coming release (a pulse under way). */
    this.holds = new Map();
    /** Relay -> number bumped by every release: a pulse decided before it never leaves. */
    this.cancels = new Map();
    this.watchTimer = undefined;
    this.irId = 0;
    this.lastCommand = undefined;
    this.onIdle = undefined;
  }

  get timers() {
    return this.app.timers;
  }

  mono() {
    return this.app.monotonic();
  }

  // --- the jobs ----------------------------------------------------------------

  enqueue(job, { front = false } = {}) {
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    if (this.stopped) {
      job.reject(new CommandError(T.stopping));
      return job.promise;
    }
    if (front) {
      // Behind the releases already waiting, ahead of everything else.
      const index = this.queue.findIndex((j) => j.kind !== 'release');
      this.queue.splice(index === -1 ? this.queue.length : index, 0, job);
    } else {
      this.queue.push(job);
    }
    this.preempt();
    this.kick();
    return job.promise;
  }

  kick() {
    if (this.current || this.stopped) return;
    const job = this.queue.shift();
    if (!job) {
      this.onIdle?.(this);
      return;
    }
    this.current = job;
    this.run(job).finally(() => {
      if (this.current === job) this.current = undefined;
      this.kick();
    });
  }

  async run(job) {
    for (let attempt = 0; ; attempt += 1) {
      const link = new Link({
        host: this.host,
        timers: this.timers,
        monotonic: () => this.mono(),
        connect: this.app.connect,
        timings: this.app.timings,
      });
      job.link = link;
      let retry = false;
      try {
        if (job.deadline !== undefined && this.mono() >= job.deadline) {
          throw new CommandError(T.noTime);
        }
        const budget =
          job.deadline === undefined
            ? this.app.timings.connectTimeout
            : Math.min(this.app.timings.connectTimeout, job.deadline - this.mono());
        await link.open(Math.max(1, budget));
        job.resolve(await job.run(link, job));
      } catch (err) {
        // Closed by the gateway before it said a word: it may still be
        // freeing the previous connection (a GC-100 serves one). The first
        // request of every job (a version read, or a release) is sent again
        // once, 50 ms later.
        retry =
          attempt === 0 &&
          !this.stopped &&
          !job.aborted &&
          link.bytesIn === 0 &&
          (err?.kind === 'closed' || err?.kind === 'unreachable') &&
          (job.deadline === undefined || job.deadline - this.mono() > 600);
        if (!retry) {
          // Given way to a release before its first byte: said so.
          job.reject(job.aborted && !job.wrote ? new CommandError(T.preempted) : err);
        }
      } finally {
        // The next connection opens only once this one is closed.
        await link.close();
      }
      if (!retry) return;
      job.retrying = true;
      await new Promise((resolve) => this.timers.setTimeout(resolve, 50));
      job.retrying = false;
      if (this.stopped) {
        job.reject(new CommandError(T.stopping));
        return;
      }
    }
  }

  /** A release or a command waiting: a reading gives way at once. */
  preempt() {
    const current = this.current;
    if (!current || !this.queue.some((j) => j.kind !== 'read')) return;
    if (current.kind === 'read') {
      current.link?.cut();
      return;
    }
    if (current.kind === 'command' && this.queue.some((j) => j.kind === 'release')) {
      // A pulse holding its connection runs the releases on it.
      if (current.holding) {
        current.wake?.();
        return;
      }
      // A command that wrote nothing yet gives way at once (even one waiting
      // on /data): its connection is cut, it can write nothing more.
      if (!current.wrote) {
        this.abort(current);
        return;
      }
      this.watchSilence();
    }
  }

  /** Drops a command that wrote nothing: the next job starts now. */
  abort(job) {
    job.aborted = true;
    job.link?.cut();
    if (this.current === job) this.current = undefined;
  }

  /** A command in the way of a release is cut once the gateway said nothing for 1 s. */
  watchSilence() {
    if (this.watchTimer !== undefined) return;
    const check = () => {
      this.watchTimer = undefined;
      const current = this.current;
      if (this.stopped || !current || current.kind !== 'command' || current.holding) return;
      if (!this.queue.some((j) => j.kind === 'release')) return;
      if (current.link?.silentFor(this.app.timings.idleCut)) {
        current.link.cut();
        return;
      }
      this.watchTimer = this.timers.setTimeout(check, 50);
    };
    this.watchTimer = this.timers.setTimeout(check, 50);
  }

  /** A release of that relay waiting or under way. */
  releasing(relay) {
    return [this.current, ...this.queue].some((j) => j?.kind === 'release' && j.relay === relay);
  }

  commandsWaiting() {
    return this.queue.filter((j) => j.kind === 'command').length;
  }

  get busy() {
    return Boolean(this.current) || this.queue.length > 0 || this.holds.size > 0;
  }

  // --- readings ------------------------------------------------------------------

  startPolling() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    this.tick();
  }

  /** The interval changed: the next reading comes at the last one + the new interval. */
  reschedule() {
    if (!this.polling || this.stopped) return;
    this.timers.clearTimeout(this.pollTimer);
    const mono = this.mono();
    const due = this.lastTick === undefined ? mono : this.lastTick + this.app.config.pollMs;
    this.pollTimer = this.timers.setTimeout(() => this.tick(), Math.max(0, due - mono));
  }

  stopPolling() {
    this.polling = false;
    this.timers.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  tick() {
    if (!this.polling || this.stopped) return;
    const mono = this.mono();
    this.lastTick = mono;
    this.pollTimer = this.timers.setTimeout(() => this.tick(), this.app.config.pollMs);
    this.read().catch(() => {});
  }

  /** One reading; joins the one waiting or under way. */
  read() {
    const pending = [this.current, ...this.queue].find((j) => j?.kind === 'read');
    if (pending) return pending.outcome;
    this.lastRead = this.mono();
    const job = { kind: 'read', run: (link) => this.runRead(link) };
    // Settles once the reading is applied (or its failure noted), never rejects.
    job.outcome = this.enqueue(job).then(
      (result) => this.readDone(result),
      (err) => this.readFailed(err),
    );
    return job.outcome;
  }

  async runRead(link) {
    let requests = 0;
    const ask = (line, match, options) => {
      requests += 1;
      if (requests > READ_REQUESTS) throw new LinkError('flood', { sent: true });
      return link.ask(line, match, options);
    };
    const identity = await this.identify(link, ask);
    const modules = await this.modules(link, ask);
    const relays = [];
    const sensors = [];
    const irPorts = [];
    const states = [];
    const flex = identity.family === 'flex';
    for (const mod of modules) {
      if (IR_TYPES.has(mod.type)) {
        const count = flex ? 3 : mod.ports;
        for (let p = 1; p <= count; p += 1) {
          if (flex) {
            irPorts.push({ m: mod.module, p });
            continue;
          }
          const mode = await this.irMode(ask, mod.module, p);
          if (mode && SENSING.has(mode)) sensors.push({ m: mod.module, p });
          else if (!mode || EMITTING.has(mode)) irPorts.push({ m: mod.module, p });
        }
      } else if (mod.type === 'RELAY') {
        for (let p = 1; p <= mod.ports; p += 1) relays.push({ m: mod.module, p });
      } else if (mod.type === 'SENSOR') {
        for (let p = 1; p <= mod.ports; p += 1) sensors.push({ m: mod.module, p });
      } else if (mod.type === 'RELAYSENSOR') {
        // Flex Link relay and sensor cable: logical relays 1 to 4 (SPST only),
        // inputs on module 2 (not listed by getdevices, a known bug).
        for (let p = 1; p <= 4; p += 1) {
          if ((await this.relayType(ask, mod.module, p)) === 'SPST') {
            relays.push({ m: mod.module, p });
          }
        }
        for (let p = 1; p <= 4; p += 1) sensors.push({ m: 2, p, optional: true });
      }
    }
    for (const kind of [relays, sensors]) {
      for (let i = 0; i < kind.length; i += 1) {
        const port = kind[i];
        try {
          const lines = await ask(`getstate,${port.m}:${port.p}`, stateOf(port));
          states.push({
            kind: kind === relays ? 'relay' : 'sensor',
            ...port,
            value: readState(lines),
          });
        } catch (err) {
          if (err?.kind !== 'device') throw err;
          // An input the cable does not have: not listed.
          if (port.optional) kind.splice(i--, 1);
        }
      }
    }
    const clean = (list) => list.map(({ m, p }) => ({ m, p }));
    return {
      info: {
        ...identity,
        relays: clean(relays),
        sensors: clean(sensors),
        irPorts: clean(irPorts),
      },
      states,
    };
  }

  async identify(link, ask = link.ask.bind(link), timeout) {
    const lines = await ask('getversion', versionAnswer, { timeout });
    const version = parseVersion(lines.at(-1));
    if (!version) throw new LinkError('timeout', { sent: true });
    return version;
  }

  async modules(link, ask = link.ask.bind(link), timeout) {
    const lines = await ask('getdevices', devicesAnswer, { timeout });
    return lines.slice(0, -1).map(parseDeviceLine).filter(Boolean).slice(0, LIMITS.deviceLines);
  }

  async irMode(ask, m, p, timeout) {
    try {
      const lines = await ask(`get_IR,${m}:${p}`, irModeOf({ m, p }), { timeout });
      return /,([A-Z0-9_]+)$/.exec(lines.at(-1))[1];
    } catch (err) {
      if (err?.kind === 'device') return undefined;
      throw err;
    }
  }

  async relayType(ask, m, p, timeout) {
    try {
      const lines = await ask(`get_RELAY,${m}:${p}`, relayTypeOf({ m, p }), { timeout });
      return /,([A-Za-z]+)$/.exec(lines.at(-1))[1];
    } catch (err) {
      if (err?.kind === 'device') return undefined;
      throw err;
    }
  }

  readDone({ info, states }) {
    if (this.stopped) return;
    const created = this.app.createdModel(this);
    const before = JSON.stringify(this.info);
    this.info = info;
    this.state = created && created !== info.model ? 'other' : 'ok';
    if (this.state === 'ok') this.app.publishStates(this, states);
    if (before !== JSON.stringify(info)) this.app.devicesChanged();
    this.app.refreshStatus();
    this.app.retryReleases(this);
  }

  readFailed(err) {
    if (this.stopped) return;
    if (err?.kind === 'cut') return; // given way to a command: not a failure
    this.state = err?.kind === 'unreachable' ? 'down' : 'answer';
    this.app.refreshStatus();
  }

  // --- relay pulse -----------------------------------------------------------------

  /** A press of a pulse button. Resolves with a text; throws a CommandError when refused. */
  async pulse(m, p, received) {
    const app = this.app;
    const relay = `${m}:${p}`;
    if (!app.config?.allowRelays) notSent(T.relaysOff);
    if (app.stopping || app.stopped) notSent(T.stopping);
    if (app.storeState === 'unreadable') notSent(T.dataUnreadable);
    if (this.holds.has(relay) || app.releaseOwed(this.host.key, m, p)) notSent(T.relayHeld);
    if (this.queue.some((j) => j.relay === relay)) notSent(T.relayHeld);
    if (this.commandsWaiting() >= LIMITS.queue) notSent(T.busy);
    const deadline = received + app.timings.commandBudget;
    const seq = this.cancels.get(relay) ?? 0;
    try {
      const text = await this.enqueue({
        kind: 'command',
        relay,
        deadline,
        run: (link, job) => this.runPulse(link, job, { m, p }, seq, deadline),
      });
      this.lastCommand = text;
      return text;
    } catch (err) {
      throw this.commandFailure(err);
    }
  }

  /** A failure of a command -> the CommandError the user reads. */
  commandFailure(err) {
    let error = err;
    if (!(err instanceof CommandError)) {
      if (
        err instanceof LinkError &&
        err.kind === 'notSent' &&
        err.reason instanceof CommandError
      ) {
        error = err.reason;
      } else if (err?.kind === 'device') {
        error = new CommandError(T.deviceRefused(err.code), { sent: true });
      } else if (err?.sent) {
        error = new CommandError(T.unexpected, { sent: true });
      } else if (err?.kind === 'unreachable') {
        error = new CommandError(T.unreachable);
      } else {
        error = new CommandError(T.unexpected);
      }
    }
    this.lastCommand = error.text;
    this.app.refreshStatus();
    return error;
  }

  async runPulse(link, job, port, seq, deadline) {
    const app = this.app;
    const { m, p } = port;
    const relay = `${m}:${p}`;
    const left = () => deadline - this.mono();
    const timeout = () => Math.max(1, Math.min(app.timings.answerTimeout, left()));
    const unsent = (fn) =>
      fn().catch((err) => {
        // A read before the pulse: nothing of the pulse left.
        if (err instanceof CommandError) throw err;
        const kind = err?.kind;
        if (kind === 'device') throw new CommandError(T.notRelay);
        throw new CommandError(kind === 'unreachable' ? T.unreachable : T.unexpected, { kind });
      });
    // Identity, port and state read again, on this connection, right before.
    const identity = await unsent(() => this.identify(link, undefined, timeout()));
    const created = app.createdModel(this);
    if (!created) notSent(T.notCreated);
    if (identity.model !== created) notSent(T.otherDevice(identity.model, created));
    const modules = await unsent(() => this.modules(link, undefined, timeout()));
    const mod = modules.find((x) => x.module === m);
    let isRelay = mod?.type === 'RELAY' && p <= mod.ports;
    if (mod?.type === 'RELAYSENSOR') {
      const type = await unsent(() => this.relayType(link.ask.bind(link), m, p, timeout()));
      isRelay = type === 'SPST' && p <= 4;
    }
    if (!isRelay) notSent(T.notRelay);
    const lines = await unsent(() =>
      link.ask(`getstate,${m}:${p}`, stateOf(port), { timeout: timeout() }),
    );
    if (readState(lines) !== 0) notSent(T.relayClosed);
    // The coming release kept in /data before the first byte.
    if (left() < 600) notSent(T.noTime);
    const kept = await app.keepRelease(
      this.host,
      m,
      p,
      Math.max(1, Math.min(app.timings.storeTimeout, left() - 400)),
    );
    if (!kept) notSent(T.dataNotKept);
    let wrote = false;
    try {
      await link.ask(`setstate,${m}:${p},1`, stateOf(port, 1), {
        timeout: Math.max(1, Math.min(app.timings.answerTimeout, left())),
        beforeSend: () => {
          if (!app.config?.allowRelays) notSent(T.relaysOff);
          if ((this.cancels.get(relay) ?? 0) !== seq) notSent(T.releasedMeanwhile);
          if (this.stopped || app.stopped || app.stopping) notSent(T.stopping);
          if (job.aborted) notSent(T.preempted);
          if (this.mono() >= deadline - 200) notSent(T.noTime);
          wrote = true;
          job.wrote = true;
          this.hold(m, p);
        },
      });
      app.publishRelay(this, m, p, 1);
      if (identity.family === 'gc100') {
        // A single connection: kept for the pulse, its release goes on it
        // (another app may take the connection as soon as it is free).
        job.resolve(T.pulseDone);
        await this.holdOnLink(link, job, relay);
      }
      return T.pulseDone;
    } catch (err) {
      if (!wrote) {
        app.dropRelease(this.host.key, m, p);
        throw err;
      }
      if (err?.kind === 'device') throw err;
      return T.pulseUnconfirmed;
    }
  }

  /**
   * The pulse job of a single-connection gateway, after its first byte:
   * keeps the connection and runs on it every release that comes (its own
   * at the end of the pulse, others meanwhile), until its own is done, the
   * connection is lost or the integration leaves (the releases left then go
   * the usual way, on a connection of their own).
   */
  async holdOnLink(link, job, relay) {
    job.holding = true;
    try {
      for (;;) {
        while (this.queue[0]?.kind === 'release' && !link.closed) {
          const release = this.queue.shift();
          release.link = link;
          try {
            release.resolve(await release.run(link, release));
          } catch (err) {
            release.reject(err);
          }
        }
        if (link.closed || this.stopped) return;
        if (!this.holds.has(relay) && !this.releasing(relay)) return;
        await Promise.race([new Promise((resolve) => (job.wake = resolve)), link.closedPromise]);
      }
    } finally {
      job.holding = false;
      job.wake = undefined;
    }
  }

  /** The release of a pulse, after its length (monotonic timer). */
  hold(m, p) {
    const relay = `${m}:${p}`;
    this.timers.clearTimeout(this.holds.get(relay));
    const timer = this.timers.setTimeout(() => {
      if (this.holds.get(relay) !== timer) return;
      this.holds.delete(relay);
      this.release(m, p).catch(() => {});
    }, this.app.config?.pulseMs ?? 500);
    this.holds.set(relay, timer);
  }

  // --- relay release (protective) ---------------------------------------------------

  /**
   * Opens a relay contact. Never refused: no option, no identity, no reading
   * needed. Cancels the pulses waiting for that relay; tried again within its
   * budget, then kept in /data and sent again by the next readings.
   */
  async release(m, p) {
    const relay = `${m}:${p}`;
    this.cancels.set(relay, (this.cancels.get(relay) ?? 0) + 1);
    this.timers.clearTimeout(this.holds.get(relay));
    this.holds.delete(relay);
    for (const job of this.queue.filter((j) => j.kind === 'command' && j.relay === relay)) {
      this.queue.splice(this.queue.indexOf(job), 1);
      job.reject(new CommandError(T.releasedMeanwhile));
    }
    const waiting = this.queue.find((j) => j.kind === 'release' && j.relay === relay);
    if (waiting) return waiting.promise;
    const start = this.mono();
    let last;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const text = await this.enqueue(
          { kind: 'release', relay, run: (link) => this.runRelease(link, m, p) },
          { front: true },
        );
        this.lastCommand = text;
        this.app.refreshStatus();
        return text;
      } catch (err) {
        last = err;
        if (this.stopped || this.mono() - start >= this.app.timings.releaseBudget) break;
      }
    }
    // Not confirmed: kept in /data (a pulse already wrote it), sent again later.
    this.app.keepRelease(this.host, m, p);
    this.lastCommand = last?.sent ? T.releaseUnconfirmed : T.releaseNotSent;
    this.app.refreshStatus();
    throw new CommandError(this.lastCommand, { sent: Boolean(last?.sent) });
  }

  async runRelease(link, m, p) {
    const port = { m, p };
    await link.ask(`setstate,${m}:${p},0`, stateOf(port, 0));
    // Confirmed by a reading made after it, never by the echo alone.
    const lines = await link.ask(`getstate,${m}:${p}`, stateOf(port));
    const value = readState(lines);
    if (value !== 0) throw new LinkError('timeout', { sent: true });
    this.app.dropRelease(this.host.key, m, p);
    this.app.publishRelay(this, m, p, 0);
    return T.released;
  }

  // --- IR ------------------------------------------------------------------------------

  /** Sends a checked code on a connector. Resolves { confirmed, text }; throws when nothing left. */
  async sendIr(port, code, received, budget) {
    if (this.commandsWaiting() >= LIMITS.queue) notSent(T.busy);
    const deadline = received + budget;
    try {
      return await this.enqueue({
        kind: 'command',
        deadline,
        run: (link, job) => this.runIr(link, job, port, code, deadline),
      });
    } catch (err) {
      throw this.commandFailure(err);
    }
  }

  async runIr(link, job, port, code, deadline) {
    const app = this.app;
    const { m, p } = port;
    const left = () => deadline - this.mono();
    const timeout = () => Math.max(1, Math.min(app.timings.answerTimeout, left()));
    const before = async (fn) => {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof CommandError) throw err;
        const kind = err?.kind;
        throw new CommandError(kind === 'unreachable' ? T.unreachable : T.unexpected, { kind });
      }
    };
    const identity = await before(() => this.identify(link, undefined, timeout()));
    const created = app.createdModel(this);
    if (!created) notSent(T.notCreated);
    if (identity.model !== created) notSent(T.otherDevice(identity.model, created));
    const limit = familyLimit(identity.family, code);
    if (limit) notSent(T.ir[limit]);
    const modules = await before(() => this.modules(link, undefined, timeout()));
    const mod = modules.find((x) => x.module === m);
    const flex = identity.family === 'flex';
    if (!mod || !IR_TYPES.has(mod.type) || p > (flex ? 3 : mod.ports)) notSent(T.notIrPort);
    if (!flex) {
      const mode = await before(() => this.irMode(link.ask.bind(link), m, p, timeout()));
      if (mode && !EMITTING.has(mode)) notSent(T.irMode(mode));
    }
    const length = irDuration(code);
    if (left() < 300) notSent(T.noTime);
    this.irId = (this.irId % 65535) + 1;
    const id = this.irId;
    try {
      await link.ask(sendirLine(port, id, code), completeOf(port, id), {
        timeout: Math.max(1, Math.min(length + app.timings.irMargin, left())),
        beforeSend: () => {
          if (this.stopped || app.stopped || app.stopping) notSent(T.stopping);
          if (job.aborted) notSent(T.preempted);
          job.wrote = true;
        },
      });
      this.lastCommand = T.irDone;
      return { confirmed: true, text: T.irDone };
    } catch (err) {
      if (err?.kind === 'device') {
        const busy = err.code === 'busy' || err.code === 'IR008';
        throw new CommandError(busy ? T.irBusy : T.deviceRefused(err.code), {
          sent: true,
        });
      }
      if (err?.sent) {
        this.lastCommand = T.irUnconfirmed;
        return { confirmed: false, text: T.irUnconfirmed };
      }
      throw err;
    }
  }

  // --- the end -------------------------------------------------------------------------

  /** Stops the readings and drops the commands waiting (releases kept). */
  disable() {
    this.stopPolling();
    for (const job of this.queue.filter((j) => j.kind !== 'release')) {
      this.queue.splice(this.queue.indexOf(job), 1);
      job.reject(new CommandError(T.stopping));
    }
    if (this.current?.kind === 'read') this.current.link?.cut();
  }

  /**
   * The integration leaves: no reading, no command any more; every relay
   * held is released now, the releases waiting go first.
   */
  leaving() {
    this.stopPolling();
    for (const job of this.queue.filter((j) => j.kind !== 'release')) {
      this.queue.splice(this.queue.indexOf(job), 1);
      job.reject(new CommandError(T.stopping));
    }
    const current = this.current;
    if (current?.kind === 'read') current.link?.cut();
    if (current?.kind === 'command' && !current.wrote) this.abort(current);
    for (const relay of [...this.holds.keys()]) {
      const [m, p] = relay.split(':').map(Number);
      this.release(m, p).catch(() => {});
    }
    current?.wake?.();
  }

  stop() {
    this.stopped = true;
    this.stopPolling();
    this.timers.clearTimeout(this.watchTimer);
    for (const timer of this.holds.values()) this.timers.clearTimeout(timer);
    this.holds.clear();
    for (const job of this.queue.splice(0)) {
      // A release not sent in time stays owed (/data, next start).
      if (job.kind === 'release') {
        const [m, p] = job.relay.split(':').map(Number);
        this.app.keepRelease(this.host, m, p);
      }
      job.reject(new CommandError(T.stopping));
    }
    // A command already written ends on its own outcome (sent, without
    // confirmation); a retry waiting on a timer is answered now.
    this.current?.link?.cut();
    if (this.current?.retrying) this.current.reject(new CommandError(T.stopping));
    this.current?.wake?.();
  }
}
