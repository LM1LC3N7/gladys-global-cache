// -----------------------------------------------------------------------------
// The Global Caché Unified TCP API (version 1.1.2), pure: the requests, the
// answers that belong to them, the error lines, the IR codes. Every line is
// printable ASCII ending with a carriage return; answers are read by exact
// patterns only (a notification of a port, a stray line, is never taken for
// the answer of another request).
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';

/** Product lines, from the version answer (getversion, section 4.3). */
const ITACH = {
  1005: 'IP2IR',
  1009: 'IP2SL',
  1008: 'IP2CC',
  1001: 'WF2IR',
  1007: 'WF2SL',
  1010: 'WF2CC',
};
const FLEX = { 2000: 'Flex WiFi', 3000: 'Flex IP' };
const CONNECT = {
  4001: 'Global Connect IR',
  4002: 'Global Connect Serial',
  4003: 'Global Connect Relay',
  4004: 'Global Connect Switch',
};

/**
 * One line of a version answer -> { family, model, firmware }, or undefined
 * when the line is not a version answer.
 */
export function parseVersion(line) {
  const gc100 = /^version,0,(\d\.\d-(06|12|18))$/.exec(line);
  if (gc100) return { family: 'gc100', model: `GC-100-${gc100[2]}`, firmware: gc100[1] };
  const unified = /^710-(\d{4})-[A-Za-z0-9.]{1,16}$/.exec(line);
  if (!unified) return undefined;
  const code = Number(unified[1]);
  if (ITACH[code]) return { family: 'itach', model: `iTach ${ITACH[code]}`, firmware: line };
  if (FLEX[code]) return { family: 'flex', model: FLEX[code], firmware: line };
  if (CONNECT[code]) return { family: 'connect', model: CONNECT[code], firmware: line };
  return { family: 'unknown', model: `Global Caché 710-${unified[1]}`, firmware: line };
}

const TYPES = [
  'IRTRIPORT_BLASTER',
  'IRTRIPORT',
  'IR_BLASTER',
  'RELAYSENSOR',
  'RELAY',
  'SENSOR',
  'SERIAL',
  'ETHERNET',
  'WIFI',
  'MODULE',
  'SWITCH',
  'IR',
];
export const IR_TYPES = new Set(['IR', 'IR_BLASTER', 'IRTRIPORT', 'IRTRIPORT_BLASTER']);

/** "device,1,3 IR" -> { module: 1, ports: 3, type: 'IR' }; undefined otherwise. */
export function parseDeviceLine(line) {
  const match = /^device,(\d),(\d) ([A-Z0-9_:]{2,32})$/.exec(line);
  if (!match) return undefined;
  const raw = match[3];
  const type = TYPES.find((t) => raw === t || raw.startsWith(`${t}_`));
  if (!type) return { module: Number(match[1]), ports: Number(match[2]), type: 'OTHER' };
  return { module: Number(match[1]), ports: Number(match[2]), type };
}

/**
 * The error line of any product line (section 5): GC-100 "unknowncommand 14",
 * iTach "ERR_1:1,014", Flex and Global Connect "ERR IR003", busy IR port.
 * -> { code } or undefined.
 */
export function parseError(line) {
  let match = /^unknowncommand (\d{1,3})$/.exec(line);
  if (match) return { code: `GC${match[1]}` };
  match = /^ERR_\d:\d,(\d{3})$/.exec(line);
  if (match) return { code: match[1] };
  match = /^ERR ([A-Z]{0,2}\d{3})$/.exec(line);
  if (match) return { code: match[1] };
  if (/^busyIR(?:,\d:\d(?:,\d{1,5})?)?$/i.test(line)) return { code: 'busy' };
  return undefined;
}

/** "1:2" -> { m: 1, p: 2 } (module 0 to 9, port 1 to 8); undefined otherwise. */
export function parseConnector(text) {
  if (typeof text !== 'string') return undefined;
  const match = /^\s*(\d):([1-8])\s*$/.exec(text);
  return match ? { m: Number(match[1]), p: Number(match[2]) } : undefined;
}

// --- IR codes ------------------------------------------------------------------

const STRICT_INT = /^\d{1,6}$/;

/**
 * A code typed by the user -> { ok: true, connector?, freq, repeat, offset,
 * values } or { ok: false, reason } (a key of i18n `T.ir`; the code is never
 * shown back). Accepted:
 *   - a whole sendir line, `sendir,1:1,<ID>,<freq>,<repeat>,<offset>,<on1>,<off1>,...`
 *     (its ID is replaced by the integration's own);
 *   - the same without `sendir,<m>:<p>,<ID>,`: `<freq>,<repeat>,<offset>,<on1>,...`;
 *   - a Pronto learned code (`0000 <freq> <once> <repeat> <pairs...>`).
 * The compressed Global Caché format is refused (letters).
 */
export function parseIrCode(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' };
  const text = raw.trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length > LIMITS.irText) return { ok: false, reason: 'tooLong' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return { ok: false, reason: 'format' };
  if (/^0000(\s+[0-9a-f]{4})+$/i.test(text)) return parsePronto(text);
  // Other Pronto kinds (0100 unmodulated, 5000 RC5...) are not converted.
  if (/^[0-9a-f]{4}(\s+[0-9a-f]{4})+$/i.test(text)) return { ok: false, reason: 'prontoKind' };
  let connector;
  let rest = text.replace(/\s+/g, '');
  const head = /^sendir,(\d:\d),(\d{1,5}),/.exec(rest);
  if (head) {
    connector = parseConnector(head[1]);
    if (!connector) return { ok: false, reason: 'connector' };
    rest = rest.slice(head[0].length);
  } else if (/^sendir/i.test(rest)) {
    return { ok: false, reason: 'format' };
  }
  if (/[A-Z]/i.test(rest)) return { ok: false, reason: 'compressed' };
  const parts = rest.split(',');
  if (parts.some((p) => !STRICT_INT.test(p))) return { ok: false, reason: 'format' };
  const [freq, repeat, offset, ...values] = parts.map(Number);
  return check({ connector, freq, repeat, offset, values });
}

/** Pronto "learned" code (0000): frequency word, once pairs, repeat pairs, then the pairs. */
function parsePronto(text) {
  const words = text.split(/\s+/).map((w) => parseInt(w, 16));
  const [, freqWord, once, again] = words;
  const values = words.slice(4);
  if (!freqWord || values.length !== (once + again) * 2 || values.length === 0) {
    return { ok: false, reason: 'pronto' };
  }
  const freq = Math.round(1_000_000 / (freqWord * 0.241246));
  // The repeated part starts after the once part (an offset is odd, 1-based).
  const offset = once > 0 && again > 0 ? once * 2 + 1 : 1;
  return check({ freq, repeat: 1, offset, values });
}

function check({ connector, freq, repeat, offset, values }) {
  if (!Number.isInteger(freq) || freq < 15_000 || freq > 500_000) {
    return { ok: false, reason: 'frequency' };
  }
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > LIMITS.irRepeat) {
    return { ok: false, reason: 'repeat' };
  }
  if (values.length < 2 || values.length % 2 !== 0) return { ok: false, reason: 'pairs' };
  if (values.length > LIMITS.irValues) return { ok: false, reason: 'tooLong' };
  // Every on and off state lasts 80 µs at least (Appendix A).
  const shortest = minPulse(freq);
  if (values.some((v) => !Number.isInteger(v) || v < shortest || v > 50_000)) {
    return { ok: false, reason: 'pulse' };
  }
  if (
    !Number.isInteger(offset) ||
    offset < 1 ||
    offset > 383 ||
    offset % 2 === 0 ||
    offset > values.length - 1
  ) {
    return { ok: false, reason: 'offset' };
  }
  const code = { ok: true, connector, freq, repeat, offset, values };
  if (irDuration(code) > LIMITS.irMaxMs) return { ok: false, reason: 'tooLongToSend' };
  return code;
}

/** The shortest pulse count at `freq`: 80 µs, rounded up. */
export function minPulse(freq) {
  return Math.max(1, Math.ceil((freq * 80) / 1_000_000 - 1e-9));
}

/** Length of the transmission, repeats included, in ms. */
export function irDuration({ freq, repeat, offset, values }) {
  const sum = (list) => list.reduce((a, b) => a + b, 0);
  const once = sum(values);
  const again = sum(values.slice(offset - 1));
  return ((once + (repeat - 1) * again) * 1000) / freq;
}

/** The sendir request of a checked code, on a port, with our ID. */
export function sendirLine({ m, p }, id, { freq, repeat, offset, values }) {
  return `sendir,${m}:${p},${id},${freq},${repeat},${offset},${values.join(',')}`;
}

/**
 * The bounds of one product line (section 4.4.1) -> the reason a checked
 * code does not fit, or undefined: GC-100 20 kHz and offset 255 at most;
 * Flex and Global Connect pulse counts of 4 at least.
 */
export function familyLimit(family, code) {
  if (family === 'gc100') {
    if (code.freq < 20_000) return 'frequency';
    if (code.offset > 255) return 'offset';
  }
  if ((family === 'flex' || family === 'connect') && code.values.some((v) => v < 4)) {
    return 'pulse';
  }
  return undefined;
}
