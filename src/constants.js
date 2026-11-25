// -----------------------------------------------------------------------------
// Fixed values: the limits of the Global Caché Unified TCP API (version 1.1.2,
// effective 2024-04-25) and of this integration, its timings, its keys.
// -----------------------------------------------------------------------------

export const DEVICE_TYPE = 'global-cache';

/** Unified TCP API port (section 3 of the manual). */
export const DEFAULT_PORT = 4998;

export const ACTIONS = Object.freeze({ TEST: 'test_connection', SEND_IR: 'send_ir' });
export const SCENE_ACTIONS = Object.freeze({ SEND_IR: 'send_ir' });

/** Sensor and relay readings, in seconds (manifest `poll_interval`). */
export const POLL = Object.freeze({ min: 10, max: 3600, default: 30 });

/** Length of a relay pulse, in ms (manifest `pulse_ms`). */
export const PULSE = Object.freeze({ min: 100, max: 10_000, default: 500 });

export const LIMITS = Object.freeze({
  gateways: 8,
  /** One line of an answer, in bytes (the longest answer is a NET line). */
  line: 256,
  /** Bytes waiting for their line end. */
  buffer: 4096,
  /** Lines of a getdevices answer. */
  deviceLines: 16,
  /** Lines read (answers, notifications of other clients) for one request. */
  linesPerRequest: 64,
  /** Values (on, off, on, off...) of an IR code; the code itself, in characters. */
  irValues: 512,
  irText: 4096,
  /** Highest repeat accepted (the lowest of the product lines, Flex and Global Connect: 20). */
  irRepeat: 20,
  /** Longest IR transmission accepted, repeats included, in ms. */
  irMaxMs: 5000,
  /** Commands waiting per gateway (releases not counted: never refused). */
  queue: 8,
  /** Relay releases kept in /data. */
  releases: 64,
  statesPerMinute: 300,
  status: 1000,
  actionText: 600,
  storeBytes: 64 * 1024,
});

export const TIMINGS = Object.freeze({
  connectTimeout: 1500,
  /** Answer to a read or a relay command. */
  answerTimeout: 1500,
  /** A release cuts a command that has said nothing for this long. */
  idleCut: 1000,
  /** A press of a relay button: the core waits 5 s, the answer goes within this. */
  commandBudget: 3300,
  /** A relay release is tried again within this, then kept in /data. */
  releaseBudget: 250,
  /** Readings that try a kept release again, at most. */
  releaseReadTries: 3,
  /** Closing an old connection before a new one, at most. */
  closeWait: 300,
  /** Margin given to an IR transmission on top of its own length. */
  irMargin: 1500,
  storeTimeout: 2000,
  dataRetry: 10_000,
  configRetry: [5000, 15_000, 30_000, 60_000],
  /** The test button, per gateway, at most once in this. */
  testGap: 5000,
});

/** Feature keys (forever: Gladys keys devices and history on them). */
export const relayKey = (m, p, what) => `relay-${m}-${p}-${what}`;
export const sensorKey = (m, p) => `sensor-${m}-${p}`;
export const FEATURE_RE = /^(relay|sensor)-(\d)-(\d)(?:-(state|pulse|release))?$/;
