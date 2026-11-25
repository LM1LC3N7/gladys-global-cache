// -----------------------------------------------------------------------------
// The Unified TCP API, pure: versions, modules, error lines, IR codes, and the
// answers that belong to a request (never another port's line).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completeOf, devicesAnswer, irModeOf, stateOf, versionAnswer } from '../src/link.js';
import {
  irDuration,
  parseConnector,
  parseDeviceLine,
  parseError,
  parseIrCode,
  parseVersion,
  sendirLine,
  familyLimit,
  minPulse,
} from '../src/protocol.js';

test('versions of every product line; anything else is no version', () => {
  assert.deepEqual(parseVersion('version,0,3.2-12'), {
    family: 'gc100',
    model: 'GC-100-12',
    firmware: '3.2-12',
  });
  assert.equal(parseVersion('710-1008-05').model, 'iTach IP2CC');
  assert.equal(parseVersion('710-1005-05').model, 'iTach IP2IR');
  assert.equal(parseVersion('710-1010-05').model, 'iTach WF2CC');
  assert.equal(parseVersion('710-2000-20').family, 'flex');
  assert.equal(parseVersion('710-4003-01').model, 'Global Connect Relay');
  assert.equal(parseVersion('710-9999-01').family, 'unknown');
  for (const bad of [
    '',
    'version,1,3.2-12',
    '710-1008',
    'state,1:1,0',
    'HTTP/1.1 400',
    '710-1008-05 ',
  ]) {
    assert.equal(parseVersion(bad), undefined, bad);
  }
});

test('module lines, subtypes included; others are not modules', () => {
  assert.deepEqual(parseDeviceLine('device,1,3 IR'), { module: 1, ports: 3, type: 'IR' });
  assert.equal(parseDeviceLine('device,1,3 IR_BLASTER').type, 'IR_BLASTER');
  assert.equal(parseDeviceLine('device,1,6 RELAY_SPST_3A').type, 'RELAY');
  assert.equal(parseDeviceLine('device,1,1 RELAYSENSOR').type, 'RELAYSENSOR');
  assert.equal(parseDeviceLine('device,1,3 SENSOR_DIGITAL').type, 'SENSOR');
  assert.equal(parseDeviceLine('device,1,1 IRTRIPORT_BLASTER').type, 'IRTRIPORT_BLASTER');
  assert.equal(parseDeviceLine('device,1,1 FOO').type, 'OTHER');
  assert.equal(parseDeviceLine('device,10,1 IR'), undefined);
  assert.equal(parseDeviceLine('endlistdevices'), undefined);
});

test('error lines of every product line', () => {
  assert.deepEqual(parseError('unknowncommand 21'), { code: 'GC21' });
  assert.deepEqual(parseError('ERR_1:1,014'), { code: '014' });
  assert.deepEqual(parseError('ERR SL001'), { code: 'SL001' });
  assert.deepEqual(parseError('ERR IR008'), { code: 'IR008' });
  assert.deepEqual(parseError('busyIR,1:1,5'), { code: 'busy' });
  assert.deepEqual(parseError('busyir'), { code: 'busy' });
  assert.equal(parseError('state,1:1,0'), undefined);
  assert.equal(parseError('ERRx'), undefined);
});

test('the answer of a request is its own: another port, another value, a notification are ignored', () => {
  const port = { m: 1, p: 2 };
  assert.equal(stateOf(port)('state,1:2,1'), 'done');
  assert.equal(stateOf(port)('state,1:3,1'), 'ignore');
  assert.equal(stateOf(port)('statechange,1:2,1'), 'ignore');
  assert.equal(stateOf(port, 1)('state,1:2,0'), 'ignore');
  assert.equal(stateOf(port, 0)('state,1:2,0'), 'done');
  assert.equal(completeOf(port, 7)('completeir,1:2,7'), 'done');
  assert.equal(completeOf(port, 7)('completeir,1:2,8'), 'ignore');
  assert.equal(irModeOf(port)('IR,1:2,SENSOR'), 'done');
  assert.equal(irModeOf(port)('IR,2:2,SENSOR'), 'ignore');
  assert.equal(versionAnswer('710-1008-05'), 'done');
  assert.equal(versionAnswer('state,1:1,0'), 'ignore');
  assert.equal(devicesAnswer('device,1,3 IR', []), 'more');
  assert.equal(devicesAnswer('endlistdevices', []), 'done');
  assert.equal(devicesAnswer('state,1:1,0', []), 'ignore');
  assert.equal(devicesAnswer('device,1,3 IR', new Array(16).fill('x')), 'ignore');
});

test('connectors', () => {
  assert.deepEqual(parseConnector('1:3'), { m: 1, p: 3 });
  assert.deepEqual(parseConnector(' 4:2 '), { m: 4, p: 2 });
  for (const bad of ['1:0', '1:9', '10:1', '1', 'a:b', '1:1:1', '', undefined]) {
    assert.equal(parseConnector(bad), undefined, String(bad));
  }
});

const NEC = '38000,1,1,342,171,21,21,21,64,21,1520';

test('IR codes: whole sendir, bare, spaces; our ID replaces theirs', () => {
  const whole = parseIrCode(`sendir,1:3,999,${NEC}`);
  assert.equal(whole.ok, true);
  assert.deepEqual(whole.connector, { m: 1, p: 3 });
  assert.equal(sendirLine({ m: 1, p: 3 }, 12, whole), `sendir,1:3,12,${NEC}`);
  const bare = parseIrCode(` ${NEC.replace(/,/g, ', ')} `);
  assert.equal(bare.ok, true);
  assert.equal(bare.connector, undefined);
  assert.deepEqual(bare.values, [342, 171, 21, 21, 21, 64, 21, 1520]);
});

test('Pronto learned codes are converted (frequency word, once and repeat parts)', () => {
  const code = parseIrCode('0000 006D 0000 0002 0010 0010 0010 0BB8');
  assert.equal(code.ok, true);
  assert.equal(code.freq, 38029);
  assert.deepEqual(code.values, [16, 16, 16, 3000]);
  assert.equal(code.offset, 1);
  const both = parseIrCode('0000 006D 0001 0001 0010 0010 0010 0BB8');
  assert.equal(both.offset, 3);
  assert.equal(parseIrCode('0000 006D 0002 0002 0010 0010').reason, 'pronto');
  assert.equal(parseIrCode('0000 0000 0001 0000 0010 0010').reason, 'pronto');
});

test('IR codes outside the API bounds are refused with their reason, never sent', () => {
  const reason = (text) => parseIrCode(text).reason;
  assert.equal(reason(''), 'empty');
  assert.equal(reason(undefined), 'empty');
  assert.equal(reason('sendir,1:1,1,40000,1,1,4,5A8,9ABB'), 'compressed');
  assert.equal(reason('14000,1,1,10,10'), 'frequency');
  assert.equal(reason('500001,1,1,10,10'), 'frequency');
  assert.equal(reason('40000,0,1,10,10'), 'repeat');
  assert.equal(reason('40000,21,1,10,10'), 'repeat');
  assert.equal(reason('40000,1,2,10,10,10,10'), 'offset');
  assert.equal(reason('40000,2,5,10,10,10,10'), 'offset');
  assert.equal(reason('40000,1,1,10,10,10'), 'pairs');
  assert.equal(reason('40000,1,1,10,0'), 'pulse');
  assert.equal(reason('40000,1,1,10,50001'), 'pulse');
  assert.equal(reason('40000,1,1,10,-5'), 'format');
  assert.equal(reason('40000,1,1,10,1.5'), 'format');
  assert.equal(reason('40000,1,1,10,'), 'format');
  assert.equal(reason('40000,1,1,10,10\r\ngetversion'), 'format');
  assert.equal(reason('sendir,1:9,1,40000,1,1,10,10'), 'connector');
  assert.equal(reason('sendir,1:1,1'), 'format');
  assert.equal(reason(`40000,1,1,${new Array(514).fill(10).join(',')}`), 'tooLong');
  assert.equal(reason('x'.repeat(5000)), 'tooLong');
  // 20 repeats of 0.5 s: 10 s of transmission.
  assert.equal(reason('40000,20,1,10000,10000'), 'tooLongToSend');
  assert.equal(parseIrCode('40000,9,1,10000,10000').ok, true);
});

test('IR duration counts the repeats from the offset; the bounds of each product line', () => {
  assert.equal(irDuration({ freq: 1000, repeat: 1, offset: 1, values: [500, 500] }), 1000);
  assert.equal(
    irDuration({ freq: 1000, repeat: 3, offset: 3, values: [100, 100, 200, 200] }),
    1400,
  );
  assert.equal(familyLimit('gc100', { freq: 19_000, offset: 1, values: [10] }), 'frequency');
  assert.equal(familyLimit('gc100', { freq: 20_000, offset: 257, values: [10] }), 'offset');
  assert.equal(familyLimit('gc100', { freq: 20_000, offset: 255, values: [10] }), undefined);
  assert.equal(familyLimit('itach', { freq: 15_000, offset: 301, values: [2] }), undefined);
  assert.equal(familyLimit('flex', { freq: 15_000, offset: 1, values: [3, 10] }), 'pulse');
  assert.equal(familyLimit('connect', { freq: 15_000, offset: 1, values: [3, 10] }), 'pulse');
  // 80 µs: 4 periods at 38 or 40 kHz, 2 at 15 kHz, 8 at 100 kHz.
  assert.deepEqual([38_000, 40_000, 15_000, 100_000].map(minPulse), [4, 4, 2, 8]);
  assert.equal(parseIrCode('40000,1,1,3,10').reason, 'pulse');
  assert.equal(parseIrCode('40000,1,1,4,10').ok, true);
  assert.equal(parseIrCode(`40000,2,385,${new Array(400).fill(10).join(',')}`).reason, 'offset');
  assert.equal(parseIrCode('0100 006D 0000 0002 0010 0010 0010 0BB8').reason, 'prontoKind');
});
