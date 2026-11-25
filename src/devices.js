// -----------------------------------------------------------------------------
// Global Caché gateways -> Gladys devices (pure).
//
// External ids (forever): `ext:<selector>:global-cache:<address>` for the
// device, the address as configured with its dots and colon turned into dashes
// (192.168.1.70 -> 192-168-1-70, itach.lan:5000 -> itach-lan-5000). The
// Unified TCP API gives no serial number nor MAC address: the address is the
// identity, so a gateway needs a fixed address (DHCP reservation). Features:
//   - `relay-<m>-<p>-state`: input/binary, READ ONLY (1 contact closed);
//   - `relay-<m>-<p>-pulse`: button/push, closes the contact for the pulse
//     length then opens it (off by default, "Allow the relays");
//   - `relay-<m>-<p>-release`: button/push, opens the contact now (never
//     blocked);
//   - `sensor-<m>-<p>`: input/binary, READ ONLY (an IR port set as sensor
//     input, a sensor module, the Flex Link relay and sensor cable).
// A relay is never a switch: a "turn everything off" or "on" scene never
// reaches it. IR outputs have no feature: codes are sent from scenes.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as TY,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE, FEATURE_RE, relayKey, sensorKey } from './constants.js';
import { T } from './i18n.js';

const READ_ONLY = {
  category: C.INPUT,
  type: TY.INPUT.BINARY,
  min: 0,
  max: 1,
  read_only: true,
  has_feedback: true,
  keep_history: true,
};
const BUTTON = {
  category: C.BUTTON,
  type: TY.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};

/** The feature id -> { hostId, kind: 'relay'|'sensor', m, p, what }, or undefined. */
export function parseFeatureId(gladys, externalId) {
  if (typeof externalId !== 'string') return undefined;
  const prefix = gladys.externalId(`${DEVICE_TYPE}:`);
  if (!externalId.startsWith(prefix)) return undefined;
  const match = /^([a-z0-9-]{1,270}):([a-z0-9-]{1,40})$/.exec(externalId.slice(prefix.length));
  if (!match) return undefined;
  const feature = FEATURE_RE.exec(match[2]);
  if (!feature) return undefined;
  const [, kind, m, p, what] = feature;
  if (kind === 'relay' && !what) return undefined;
  if (kind === 'sensor' && what) return undefined;
  return { hostId: match[1], kind, m: Number(m), p: Number(p), what };
}

export const deviceId = (gladys, hostId) => gladys.externalIds(DEVICE_TYPE, hostId).device;

/**
 * One Gladys device. `info`: the last reading ({ model, firmware, relays,
 * sensors, irPorts }); `existing`: the device as Gladys has it (a relay or an
 * input not seen this time keeps its features).
 */
export function buildDevice(gladys, host, info, language, existing) {
  const ids = gladys.externalIds(DEVICE_TYPE, host.id);
  const lang = language === 'en' ? 'en' : 'fr';
  const relays = new Map(info.relays.map((r) => [`${r.m}:${r.p}`, r]));
  const sensors = new Map(info.sensors.map((s) => [`${s.m}:${s.p}`, s]));
  for (const feature of existing?.features ?? []) {
    const parsed = parseFeatureId(gladys, feature.external_id);
    if (parsed?.hostId !== host.id) continue;
    const target = parsed.kind === 'relay' ? relays : sensors;
    target.set(`${parsed.m}:${parsed.p}`, { m: parsed.m, p: parsed.p });
  }
  const order = (a, b) => a.m - b.m || a.p - b.p;
  const features = [];
  for (const { m, p } of [...relays.values()].sort(order)) {
    const c = `${m}:${p}`;
    features.push(
      {
        ...READ_ONLY,
        name: T.relayState[lang](c),
        external_id: ids.feature(relayKey(m, p, 'state')),
      },
      { ...BUTTON, name: T.relayPulse[lang](c), external_id: ids.feature(relayKey(m, p, 'pulse')) },
      {
        ...BUTTON,
        name: T.relayRelease[lang](c),
        external_id: ids.feature(relayKey(m, p, 'release')),
      },
    );
  }
  for (const { m, p } of [...sensors.values()].sort(order)) {
    features.push({
      ...READ_ONLY,
      name: T.sensor[lang](`${m}:${p}`),
      external_id: ids.feature(sensorKey(m, p)),
    });
  }
  const irPorts = info.irPorts.map((r) => `${r.m}:${r.p}`).join(', ');
  return {
    name: existing?.name ?? `${info.model} ${host.key}`,
    external_id: ids.device,
    features,
    params: [
      { name: 'address', value: host.key },
      { name: 'model', value: info.model },
      { name: 'firmware', value: info.firmware },
      { name: 'ir_ports', value: irPorts || '-' },
    ],
  };
}

/** The model a created device was made from (its `model` param), or undefined. */
export function createdModel(device) {
  const param = (device?.params ?? []).find((p) => p.name === 'model');
  return typeof param?.value === 'string' ? param.value : undefined;
}
