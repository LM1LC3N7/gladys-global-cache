// -----------------------------------------------------------------------------
// The configuration: addresses checked, ids without dots or colons, values
// bounded, relays off by default.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, parseHost } from '../src/config.js';

test('addresses: IPv4 and names, port 4998 by default, no broadcast nor multicast', () => {
  assert.deepEqual(parseHost('192.168.1.70'), {
    address: '192.168.1.70',
    port: 4998,
    key: '192.168.1.70',
    id: '192-168-1-70',
  });
  assert.equal(parseHost('192.168.1.70:4998').key, '192.168.1.70');
  assert.equal(parseHost('iTach.LAN:5000').id, 'itach-lan-5000');
  // A host of a /16 to /23 network.
  assert.equal(parseHost('10.0.1.255').key, '10.0.1.255');
  assert.equal(parseHost('10.0.2.0').key, '10.0.2.0');
  for (const bad of [
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '239.255.250.250',
    '192.168.1.70:0',
    '192.168.1.70:70000',
    'http://x',
    'a b',
    'user@host',
    'host\r\nx',
    '[::1]',
    '1.2.3',
    '',
    undefined,
  ]) {
    assert.equal(parseHost(bad), undefined, String(bad));
  }
});

test('normalized: bounded values, invalid addresses counted (never shown), ids unique', () => {
  const config = normalizeConfig({
    gateways: '192.168.1.70, bad host, 192.168.1.70:4998, a-b.lan, a.b-lan',
    poll_interval: 1,
    pulse_ms: 99_999,
  });
  assert.deepEqual(
    config.hosts.map((h) => h.key),
    ['192.168.1.70', 'a-b.lan'],
  );
  assert.equal(config.invalid, 2);
  assert.equal(config.pollMs, 10_000);
  assert.equal(config.pulseMs, 10_000);
  assert.equal(config.allowRelays, false);
  assert.equal(normalizeConfig({ gateways: '' }).problem, 'noHost');
  assert.equal(normalizeConfig({ gateways: 'x y' }).problem, 'hostsInvalid');
  assert.equal(normalizeConfig(null).problem, 'noHost');
  const many = Array.from({ length: 9 }, (_, i) => `192.168.1.${i + 10}`).join(',');
  assert.equal(normalizeConfig({ gateways: many }).problem, 'tooManyHosts');
  assert.equal(normalizeConfig({ gateways: '10.0.0.5', allow_relays: 'true' }).allowRelays, true);
  assert.equal(normalizeConfig({ gateways: '10.0.0.5', allow_relays: 'yes' }).allowRelays, false);
  assert.equal(normalizeConfig({ gateways: '10.0.0.5', pulse_ms: '' }).pulseMs, 500);
  assert.equal(DEFAULT_CONFIG.allow_relays, false);
});
