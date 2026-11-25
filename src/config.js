// -----------------------------------------------------------------------------
// The configuration, normalized: every value bounded, every address checked.
// DEFAULT_CONFIG mirrors the manifest defaults (test/manifest.test.js).
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { DEFAULT_PORT, LIMITS, POLL, PULSE } from './constants.js';

export const DEFAULT_CONFIG = Object.freeze({
  poll_interval: POLL.default,
  allow_relays: false,
  pulse_ms: PULSE.default,
  language: 'fr',
});

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/**
 * An IPv4 address that is never a gateway: "this network" (0.x), multicast,
 * reserved and the limited broadcast (224 and up). A last byte .0 or .255
 * is a host in a /16 to /23 network: accepted (the mask is unknown here,
 * and a TCP connection to a subnet broadcast address fails anyway).
 */
function unusableIpv4(address) {
  const first = Number(address.split('.')[0]);
  return first === 0 || first >= 224;
}

/**
 * "192.168.1.70", "192.168.1.70:4998" or "itach.lan" -> { address, port, key, id }.
 * `id`: the part of the external ids (no dot, no colon). undefined when it is
 * not a usable gateway address.
 */
export function parseHost(text) {
  if (typeof text !== 'string') return undefined;
  const value = text.trim();
  if (!value || value.length > 260 || CONTROL.test(value) || /[\s/@?#\\[\]]/.test(value)) {
    return undefined;
  }
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(value);
  if (!match) return undefined;
  const address = match[1].toLowerCase();
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (isIP(address) === 4) {
    if (unusableIpv4(address)) return undefined;
  } else if (/^[\d.]+$/.test(address) || !HOSTNAME.test(address)) {
    return undefined;
  }
  const key = port === DEFAULT_PORT ? address : `${address}:${port}`;
  const id = key.replace(/[.:]/g, '-');
  return { address, port, key, id };
}

const boundedInt = (value, { min, max, default: fallback }) => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
};

const bool = (value) => value === true || value === 'true' || value === 1 || value === '1';

/**
 * -> { hosts: [{ address, port, key, id }], invalid (count: the text is never
 *      shown back), pollMs, allowRelays, pulseMs, language, problem }
 * `problem` is a key of i18n (a configuration that cannot run), or undefined.
 */
export function normalizeConfig(raw = {}) {
  const config = raw ?? {};
  const hosts = [];
  let invalid = 0;
  const ids = new Set();
  const list = typeof config.gateways === 'string' ? config.gateways.split(/[,;\n]/) : [];
  for (const entry of list) {
    if (!entry.trim()) continue;
    const host = parseHost(entry);
    if (!host) {
      invalid += 1;
      continue;
    }
    // "a-b.lan" and "a.b-lan" would share an id: the second one is refused.
    if (ids.has(host.id)) {
      if (!hosts.some((h) => h.key === host.key)) invalid += 1;
      continue;
    }
    ids.add(host.id);
    hosts.push(host);
  }
  let problem;
  if (hosts.length === 0) problem = invalid ? 'hostsInvalid' : 'noHost';
  else if (hosts.length > LIMITS.gateways) problem = 'tooManyHosts';
  return {
    hosts: hosts.slice(0, LIMITS.gateways),
    invalid,
    pollMs: boundedInt(config.poll_interval, POLL) * 1000,
    allowRelays: bool(config.allow_relays),
    pulseMs: boundedInt(config.pulse_ms, PULSE),
    language: config.language === 'en' ? 'en' : 'fr',
    problem,
  };
}
