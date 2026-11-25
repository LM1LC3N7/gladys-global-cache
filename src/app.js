// -----------------------------------------------------------------------------
// GlobalCacheApp: the configuration, one Gateway per address
// (src/gateway.js), Discovery, the states published to Gladys under their
// rate limit, the status of the Configuration screen, the relay releases kept
// in /data (src/store.js).
//
// Clocks are injected: `monotonic` for every decision (deadlines, intervals,
// windows, limits), `now` for /data dates only; `timers` for every timer.
// -----------------------------------------------------------------------------

import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { normalizeConfig, parseHost } from './config.js';
import { LIMITS, TIMINGS, relayKey, sensorKey } from './constants.js';
import { buildDevice, createdModel, deviceId, parseFeatureId } from './devices.js';
import { RateLimiter } from './events.js';
import { CommandError, Gateway } from './gateway.js';
import { T, join, pick } from './i18n.js';
import { parseConnector, parseIrCode } from './protocol.js';
import { FileStore, emptyData, releaseKey } from './store.js';

const withTimeout = (promise, ms, timers) =>
  new Promise((resolve, reject) => {
    const timer = timers.setTimeout(() => reject(new Error('timeout')), ms);
    Promise.resolve(promise).then(
      (value) => {
        timers.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        timers.clearTimeout(timer);
        reject(err);
      },
    );
  });

export class GlobalCacheApp {
  constructor({
    gladys,
    logger = console,
    store = new FileStore(),
    timers = globalThis,
    now = Date.now,
    monotonic = () => performance.now(),
    timings = {},
    connect = net.connect,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.timers = timers;
    this.now = now;
    this.monotonic = monotonic;
    this.timings = { ...TIMINGS, ...timings };
    this.connect = connect;
    this.gateways = new Map();
    this.config = undefined;
    this.data = undefined;
    this.storeState = undefined;
    this.dataLoading = undefined;
    this.chain = Promise.resolve();
    this.stopped = false;
    this.lastStatus = undefined;
    this.statusQueued = false;
    this.discoveryQueued = false;
    this.published = new Map();
    this.dataTimer = undefined;
    /**
     * The releases owed (key -> { host, m, p, at }): in memory always, and
     * in /data whenever the file is readable (an unreadable /data never
     * loses one: it is kept here and sent again all the same).
     */
    this.owed = new Map();
    /** Release key -> { tries, due }: the next try of an owed release (its own timer). */
    this.retries = new Map();
    this.retryTimer = undefined;
    /** Set as soon as stop() starts: no pulse nor IR code leaves after it. */
    this.stopping = false;
    this.stateLimiter = new RateLimiter(LIMITS.statesPerMinute);
  }

  // --- lifecycle -------------------------------------------------------------

  /**
   * At process start, before Gladys is even reached: the releases kept in
   * /data are sent at once (a restart in the middle of a pulse).
   */
  async boot() {
    await this.loadData();
    this.sendKeptReleases();
  }

  sendKeptReleases() {
    if (this.stopped) return;
    for (const entry of [...this.owed.values()]) {
      const host = parseHost(entry.host);
      if (!host) continue;
      this.logger.info(`Relay ${entry.m}:${entry.p} of ${host.key}: release owed, sent`);
      this.gatewayFor(host)
        .release(entry.m, entry.p)
        .catch(() => {});
    }
  }

  /** A configuration (start, save, reconnection): applied one at a time, the last one wins. */
  start(raw) {
    const run = this.chain.then(() => this.apply(raw));
    this.chain = run.catch(() => {});
    return run;
  }

  loadData() {
    if (this.data) return Promise.resolve();
    this.dataLoading ??= (async () => {
      let loaded;
      try {
        loaded = await this.store.load();
      } catch {
        loaded = { state: 'unreadable' };
      }
      this.data = loaded.state === 'unreadable' ? emptyData() : (loaded.data ?? emptyData());
      this.storeState = loaded.state;
      for (const [key, entry] of Object.entries(this.data.releases)) {
        if (!this.owed.has(key)) this.owed.set(key, entry);
      }
      if (loaded.state === 'unreadable') this.scheduleDataRetry();
    })();
    return this.dataLoading;
  }

  /** /data unreadable: read again on a timer of its own, one read at a time. */
  scheduleDataRetry() {
    if (this.stopped || this.dataTimer !== undefined) return;
    this.dataTimer = this.timers.setTimeout(() => {
      this.dataTimer = undefined;
      this.retryData().catch((err) => this.logger.warn('/data not read', err?.message));
    }, this.timings.dataRetry);
  }

  async retryData() {
    if (this.stopped || this.storeState !== 'unreadable') return;
    let loaded;
    try {
      loaded = await this.store.load();
    } catch {
      loaded = { state: 'unreadable' };
    }
    if (this.stopped) return;
    if (loaded.state === 'unreadable' || !loaded.data) {
      this.scheduleDataRetry();
      return;
    }
    // Readable now: its releases join the ones owed meanwhile (kept in
    // memory), all written back and sent.
    const before = this.owed.size;
    for (const [key, entry] of Object.entries(loaded.data.releases)) {
      if (!this.owed.has(key)) this.owed.set(key, entry);
    }
    this.data = loaded.data;
    this.storeState = loaded.state;
    this.logger.info('/data read again');
    if (before) this.persist();
    this.sendKeptReleases();
    this.refreshStatus();
  }

  async apply(raw) {
    if (this.stopped) return;
    await this.loadData();
    if (this.stopped) return;
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.restart();
    if (previous && previous.pollMs !== this.config.pollMs) {
      for (const gateway of this.gateways.values()) gateway.reschedule();
    }
    // Fresh states only: what Gladys had is published again from the next readings.
    this.published.clear();
    this.gladys.forgetPublishedStates?.();
    this.lastStatus = undefined;
    this.refreshStatus();
    this.scan();
  }

  /** The gateway of an address, made when missing (not polled until configured). */
  gatewayFor(host) {
    let gateway = this.gateways.get(host.key);
    if (!gateway) {
      gateway = new Gateway(this, host);
      this.gateways.set(host.key, gateway);
    }
    return gateway;
  }

  restart() {
    const config = this.config;
    const wanted = new Map(
      config.problem && config.problem !== 'tooManyHosts'
        ? []
        : config.hosts.map((h) => [h.key, h]),
    );
    for (const [key, gateway] of this.gateways) {
      if (wanted.has(key)) continue;
      gateway.disable();
      // A release still under way finishes first.
      const drop = (g) => {
        if (this.gateways.get(key) === g && !g.polling && !g.busy) {
          g.stop();
          this.gateways.delete(key);
        }
      };
      gateway.onIdle = drop;
      drop(gateway);
    }
    for (const host of wanted.values()) {
      const gateway = this.gatewayFor(host);
      gateway.onIdle = undefined;
      gateway.startPolling();
    }
  }

  configured(gateway) {
    return this.gateways.get(gateway.host.key) === gateway && gateway.polling;
  }

  /**
   * Leaving: nothing more leaves but releases. Every relay held, being
   * pulsed or with a release waiting is released within a bounded window
   * (real time, 2 s); what is left stays owed in /data for the next start.
   */
  async stop() {
    if (this.stopped || this.stopping) return;
    this.stopping = true;
    this.timers.clearTimeout(this.retryTimer);
    for (const gateway of this.gateways.values()) gateway.leaving();
    const end = performance.now() + this.timings.stopWindow;
    const settled = () =>
      [...this.gateways.values()].every((g) => !g.current && !g.queue.length && !g.holds.size);
    // Real time on purpose: the process is leaving, whatever the clock given.
    while (!settled() && performance.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    this.stopped = true;
    this.timers.clearTimeout(this.dataTimer);
    this.dataTimer = undefined;
    for (const gateway of this.gateways.values()) gateway.stop();
    this.gateways.clear();
  }

  // --- releases kept in /data ------------------------------------------------------

  releaseOwed(hostKey, m, p) {
    return this.owed.has(releaseKey(hostKey, m, p));
  }

  /**
   * Keeps a release owed. With `ms` (a pulse, before its first byte):
   * written to /data and awaited, true only when written within `ms` (not
   * written: forgotten again). Without (a release that failed): kept in
   * memory in any case, written in the background when /data is readable,
   * and tried again on its own timer.
   */
  async keepRelease(host, m, p, ms) {
    const key = releaseKey(host.key, m, p);
    const had = this.owed.has(key);
    const entry = { host: host.key, m, p, at: this.now() };
    if (ms === undefined) {
      this.owed.set(key, had ? this.owed.get(key) : entry);
      this.persist();
      this.scheduleRetry(key);
      this.refreshStatus();
      return true;
    }
    if (this.storeState === 'unreadable' || !this.data) return false;
    if (!had && this.owed.size >= LIMITS.releases) return false;
    this.owed.set(key, entry);
    let ok;
    try {
      ok = (await withTimeout(this.store.save(this.snapshot()), ms, this.timers)) !== false;
    } catch {
      ok = false;
    }
    if (!ok && !had) this.owed.delete(key);
    return ok;
  }

  dropRelease(hostKey, m, p) {
    const key = releaseKey(hostKey, m, p);
    this.retries.delete(key);
    if (!this.owed.delete(key)) return;
    this.persist();
    this.refreshStatus();
  }

  /** Next try of an owed release: 1 s, 2 s, 5 s, 10 s, 30 s, then every minute. */
  scheduleRetry(key) {
    if (this.stopped || this.stopping || !this.owed.has(key)) return;
    const state = this.retries.get(key) ?? { tries: 0 };
    const delays = this.timings.releaseRetry;
    state.due = this.monotonic() + delays[Math.min(state.tries, delays.length - 1)];
    state.tries += 1;
    this.retries.set(key, state);
    this.armRetryTimer();
  }

  armRetryTimer() {
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.stopped || this.stopping || !this.retries.size) return;
    const next = Math.min(...[...this.retries.values()].map((r) => r.due));
    this.retryTimer = this.timers.setTimeout(
      () => this.runRetries(),
      Math.max(0, next - this.monotonic()),
    );
  }

  runRetries() {
    this.retryTimer = undefined;
    const mono = this.monotonic();
    for (const [key, state] of [...this.retries]) {
      const entry = this.owed.get(key);
      if (!entry) {
        this.retries.delete(key);
        continue;
      }
      if (state.due > mono) continue;
      state.due = Infinity; // the outcome of this try schedules the next one
      const host = parseHost(entry.host);
      if (!host) continue;
      this.gatewayFor(host)
        .release(entry.m, entry.p)
        .catch(() => {});
    }
    this.armRetryTimer();
  }

  /**
   * After a reading: the gateway answers, the releases owed to it are tried
   * at once (one try per reading; their own timer goes on besides).
   */
  retryReleases(gateway) {
    for (const entry of [...this.owed.values()]) {
      if (entry.host !== gateway.host.key) continue;
      const relay = `${entry.m}:${entry.p}`;
      if (gateway.holds.has(relay) || gateway.releasing(relay)) continue;
      gateway.release(entry.m, entry.p).catch(() => {});
    }
  }

  owedCount(gateway) {
    return [...this.owed.values()].filter((e) => e.host === gateway.host.key).length;
  }

  /** What /data holds: the owed releases (64 at most). */
  snapshot() {
    return {
      ...structuredClone(this.data ?? emptyData()),
      releases: Object.fromEntries([...this.owed].slice(0, LIMITS.releases)),
    };
  }

  /** Never awaited: a slow disk holds nothing. An unreadable file is never overwritten. */
  persist() {
    if (this.storeState === 'unreadable' || !this.data) return;
    Promise.resolve(this.store.save(this.snapshot())).then(
      (ok) => {
        if (ok === false) this.logger.warn('/data could not be written');
      },
      () => this.logger.warn('/data could not be written'),
    );
  }

  // --- Gladys ------------------------------------------------------------------

  createdDevice(gateway) {
    const id = deviceId(this.gladys, gateway.host.id);
    return (this.gladys.devices ?? []).find((d) => d.external_id === id);
  }

  createdModel(gateway) {
    return createdModel(this.createdDevice(gateway));
  }

  /** The gateways read in this run, as Discovery shows them. */
  async scan() {
    if (this.stopped || !this.config) return;
    const devices = [];
    for (const gateway of this.gateways.values()) {
      if (!gateway.info || !this.configured(gateway) || gateway.state === 'other') continue;
      devices.push(
        buildDevice(
          this.gladys,
          gateway.host,
          gateway.info,
          this.config.language,
          this.createdDevice(gateway),
        ),
      );
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
    } catch (err) {
      this.logger.warn('Discovery not published', err?.message);
    }
  }

  devicesChanged() {
    if (this.discoveryQueued) return;
    this.discoveryQueued = true;
    queueMicrotask(() => {
      this.discoveryQueued = false;
      this.scan();
    });
  }

  async deviceCreated(device) {
    // Its states are published again from the next reading (never a cached value).
    for (const key of [...this.published.keys()]) {
      if (key.startsWith(`${device?.external_id}:`)) this.published.delete(key);
    }
    this.refreshStatus();
  }

  /** States of a fresh reading, for a device created in Gladys only. */
  publishStates(gateway, states) {
    const device = this.createdDevice(gateway);
    if (!device) return;
    const ids = new Set((device.features ?? []).map((f) => f.external_id));
    const out = [];
    for (const s of states) {
      const key = s.kind === 'relay' ? relayKey(s.m, s.p, 'state') : sensorKey(s.m, s.p);
      const id = `${device.external_id}:${key}`;
      if (!ids.has(id) || this.published.get(id) === s.value) continue;
      out.push({ device_feature_external_id: id, state: s.value });
    }
    this.send(out);
  }

  publishRelay(gateway, m, p, value) {
    if (gateway.state !== 'ok') return;
    this.publishStates(gateway, [{ kind: 'relay', m, p, value }]);
  }

  send(states) {
    if (this.stopped || !states.length) return;
    const allowed = [];
    for (const s of states) {
      if (!this.stateLimiter.take(this.monotonic())) break;
      allowed.push(s);
      this.published.set(s.device_feature_external_id, s.state);
    }
    if (!allowed.length) return;
    this.gladys.publishStates(allowed).catch((err) => {
      for (const s of allowed) this.published.delete(s.device_feature_external_id);
      this.logger.warn('States not published', err?.message);
    });
  }

  // --- commands ----------------------------------------------------------------

  gatewayOfDevice(externalId) {
    for (const gateway of this.gateways.values()) {
      if (this.configured(gateway) && deviceId(this.gladys, gateway.host.id) === externalId) {
        return gateway;
      }
    }
    return undefined;
  }

  async setValue(device, feature, value) {
    const received = this.monotonic();
    const language = this.config?.language;
    const refuse = (text) => {
      throw new Error(pick(text, language));
    };
    const target = parseFeatureId(this.gladys, feature?.external_id);
    if (!target) refuse(T.unknownDevice);
    if (target.kind !== 'relay' || target.what === 'state') refuse(T.notButton);
    if (value !== 1 && value !== '1') refuse(T.badValue);
    const gateway = [...this.gateways.values()].find((g) => g.host.id === target.hostId);
    if (target.what === 'release') {
      // Protective: no configuration, no option, no reading needed.
      const host = gateway?.host ?? hostOfDevice(device, target.hostId, this.owed);
      if (!host) refuse(T.unknownDevice);
      try {
        return pick(await this.gatewayFor(host).release(target.m, target.p), language);
      } catch (err) {
        refuse(err.text ?? T.unexpected);
      }
    }
    if (!this.config) refuse(T.configLoading);
    if (!gateway || !this.configured(gateway)) refuse(T.unknownDevice);
    try {
      const text = await gateway.pulse(target.m, target.p, received);
      this.logger.info(`Relay ${target.m}:${target.p} of ${gateway.host.key}: ${text.en}`);
      return pick(text, language);
    } catch (err) {
      const text = err instanceof CommandError ? err.text : T.unexpected;
      this.logger.warn(`Relay ${target.m}:${target.p} of ${gateway.host.key}: ${text.en}`);
      refuse(text);
    }
  }

  /**
   * An IR code from a scene or the Configuration screen: { device, connector,
   * code } -> { confirmed, text }. Throws (nothing sent) with a clear text.
   */
  async sendIr(fields, budget) {
    const received = this.monotonic();
    const language = this.config?.language;
    const refuse = (text) => {
      throw new Error(pick(text, language));
    };
    if (!this.config) refuse(T.configLoading);
    const gateway = this.gatewayOfDevice(fields?.device);
    if (!gateway) refuse(T.unknownDevice);
    const code = parseIrCode(fields?.code);
    if (!code.ok) refuse(T.ir[code.reason]);
    const typed = String(fields?.connector ?? '').trim();
    const connector = typed ? parseConnector(typed) : code.connector;
    if (typed && !connector) refuse(T.notIrPort);
    if (!connector) refuse(T.connectorMissing);
    if (code.connector && (code.connector.m !== connector.m || code.connector.p !== connector.p)) {
      refuse(T.connectorMismatch);
    }
    try {
      const result = await gateway.sendIr(connector, code, received, budget);
      this.refreshStatus();
      return result;
    } catch (err) {
      const text = err instanceof CommandError ? err.text : T.unexpected;
      this.logger.warn(`IR on ${gateway.host.key} ${connector.m}:${connector.p}: ${text.en}`);
      refuse(text);
    }
  }

  /** The test button: every gateway read (each at most every 5 s). */
  async testConnection() {
    if (!this.config) return T.configLoading;
    if (this.config.problem && this.config.problem !== 'tooManyHosts') {
      return T[this.config.problem];
    }
    const gateways = [...this.gateways.values()].filter((g) => this.configured(g));
    if (!gateways.length) return T.testNoHost;
    await Promise.all(
      gateways.map((g) => {
        const fresh =
          g.lastRead !== undefined && this.monotonic() - g.lastRead < this.timings.testGap;
        return fresh && !g.current && !g.queue.length ? undefined : g.read();
      }),
    );
    this.refreshStatus();
    return join(gateways.map((g) => this.statusLine(g)));
  }

  // --- status ------------------------------------------------------------------

  statusLine(gateway) {
    const key = gateway.host.key;
    let line;
    switch (gateway.state) {
      case 'ok':
        line = T.ok(
          key,
          gateway.info.model,
          gateway.info.relays.length,
          gateway.info.sensors.length,
        );
        break;
      case 'other':
        line = T.other(key, gateway.info.model, this.createdModel(gateway));
        break;
      case 'down':
        line = T.down(key);
        break;
      case 'answer':
        line = T.answer(key);
        break;
      default:
        line = T.starting(key);
    }
    const extras = [];
    const owed = this.owedCount(gateway);
    if (owed) extras.push(T.owed(key, owed, this.storeState === 'unreadable'));
    if (gateway.lastCommand) extras.push(T.lastCommand(gateway.lastCommand));
    return extras.length ? join([line, ...extras]) : line;
  }

  refreshStatus() {
    if (this.statusQueued) return;
    this.statusQueued = true;
    queueMicrotask(() => {
      this.statusQueued = false;
      this.publishStatus();
    });
  }

  publishStatus() {
    if (this.stopped || !this.config) return;
    const config = this.config;
    let connected = false;
    const parts = [];
    if (config.problem && config.problem !== 'tooManyHosts') {
      parts.push(T[config.problem]);
    } else {
      if (config.problem) parts.push(T[config.problem]);
      for (const gateway of this.gateways.values()) {
        if (!this.configured(gateway)) continue;
        if (gateway.state === 'ok') connected = true;
        parts.push(this.statusLine(gateway));
      }
      if (!config.allowRelays) parts.push(T.relaysOff);
    }
    if (config.invalid) parts.push(T.ignored(config.invalid));
    if (this.storeState === 'unreadable') parts.push(T.dataUnreadable);
    const message = join(parts);
    const key = `${connected}\n${message.fr}\n${message.en}`;
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.gladys.setConnectionStatus(connected, message).catch(() => {
      this.lastStatus = undefined;
    });
  }
}

/**
 * The address behind a device id before the configuration is read: the
 * `address` param of the device, or a release owed.
 */
function hostOfDevice(device, id, owed) {
  const param = (device?.params ?? []).find((p) => p.name === 'address');
  const fromDevice = parseHost(param?.value);
  if (fromDevice?.id === id) return fromDevice;
  for (const entry of owed.values()) {
    const host = parseHost(entry.host);
    if (host?.id === id) return host;
  }
  return undefined;
}
