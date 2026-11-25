// -----------------------------------------------------------------------------
// A fake Global Caché gateway on a real loopback TCP socket, answering like
// the Unified TCP API 1.1.2 manual says: iTach IP2CC (3 relays), iTach IP2IR
// (3 IR ports, port 2 set as sensor input), GC-100-12 (relays on module 3,
// IR on 4 and 5, a single connection at a time, "unknowncommand" errors),
// Flex with the Flex Link relay and sensor cable. One line read at a time
// (as the firmware): requests glued in one chunk are answered in order.
// Counters: connections, open, peak, refused; `lines` every request with its
// connection number; `history` every relay change.
// -----------------------------------------------------------------------------

import net from 'node:net';

const MODELS = {
  IP2CC: {
    version: '710-1008-05',
    devices: ['device,0,0 ETHERNET', 'device,1,3 RELAY'],
    relays: ['1:1', '1:2', '1:3'],
    family: 'itach',
  },
  IP2IR: {
    version: '710-1005-05',
    devices: ['device,0,0 ETHERNET', 'device,1,3 IR'],
    ir: { '1:1': 'IR', '1:2': 'SENSOR', '1:3': 'IR_BLASTER' },
    family: 'itach',
  },
  GC100: {
    version: 'version,0,3.2-12',
    devices: [
      'device,1,1 SERIAL',
      'device,2,1 SERIAL',
      'device,3,3 RELAY',
      'device,4,3 IR',
      'device,5,3 IR',
    ],
    relays: ['3:1', '3:2', '3:3'],
    ir: { '4:1': 'IR', '4:2': 'IR', '4:3': 'SENSOR', '5:1': 'IR', '5:2': 'IR', '5:3': 'IR' },
    family: 'gc100',
    maxConnections: 1,
  },
  FLEXRS: {
    version: '710-2000-20',
    devices: ['device,0,0 WIFI', 'device,1,1 RELAYSENSOR'],
    relays: ['1:1', '1:2', '1:3', '1:4'],
    relayTypes: { '1:1': 'SPST', '1:2': 'SPST', '1:3': 'SPDT', '1:4': 'Unavailable' },
    sensors: ['2:1', '2:2', '2:3', '2:4'],
    family: 'flex',
  },
};

function errorLine(family, m, p, code) {
  if (family === 'gc100') return `unknowncommand ${Number(code)}`;
  if (family === 'itach') return `ERR_${m ?? 0}:${p ?? 0},${code}`;
  return `ERR ${code}`;
}

export async function startFakeGc(model = 'IP2CC', options = {}) {
  const spec = MODELS[model];
  const state = {
    relays: new Map((spec.relays ?? []).map((k) => [k, 0])),
    sensors: new Map(
      [
        ...(spec.sensors ?? []),
        ...Object.entries(spec.ir ?? {})
          .filter(([, mode]) => mode === 'SENSOR')
          .map(([k]) => k),
      ].map((k) => [k, 0]),
    ),
    ir: { ...(spec.ir ?? {}) },
    relayTypes: { ...(spec.relayTypes ?? {}) },
  };
  const fake = {
    model,
    spec,
    state,
    version: spec.version,
    latencyMs: options.latencyMs ?? 0,
    irMs: options.irMs ?? 0,
    /** No answer at all (a frozen firmware). */
    silent: false,
    /** Commands that get no answer (prefix -> true). */
    mute: new Set(),
    /** Lines answered by a function: (line, conn) => string | string[] | undefined. */
    hooks: [],
    maxConnections: options.maxConnections ?? spec.maxConnections ?? 8,
    connections: 0,
    open: 0,
    peak: 0,
    refused: 0,
    lines: [],
    history: [],
    sockets: new Set(),
    timers: new Set(),
    irBusy: new Map(),
  };

  const send = (socket, text) => {
    if (socket.destroyed) return;
    const out = Array.isArray(text) ? text : [text];
    const write = () => {
      if (!socket.destroyed) socket.write(out.map((l) => `${l}\r`).join(''));
    };
    if (fake.latencyMs) setTimeout(write, fake.latencyMs);
    else write();
  };

  function answer(line, conn, socket) {
    for (const hook of fake.hooks) {
      const result = hook(line, conn, socket);
      if (result !== undefined) return result;
    }
    if ([...fake.mute].some((prefix) => line.startsWith(prefix))) return undefined;
    const fam = spec.family;
    let match;
    if (line === 'getversion') return fake.version;
    if (line === 'getdevices') return [...spec.devices, 'endlistdevices'];
    if ((match = /^get_IR,(\d):(\d)$/.exec(line))) {
      const mode = state.ir[`${match[1]}:${match[2]}`];
      return mode
        ? `IR,${match[1]}:${match[2]},${mode}`
        : errorLine(fam, match[1], match[2], '014');
    }
    if ((match = /^get_RELAY,(\d):(\d)$/.exec(line))) {
      const type = state.relayTypes[`${match[1]}:${match[2]}`];
      return type ? `RELAY,${match[1]}:${match[2]},${type}` : errorLine(fam, 0, 0, 'RO004');
    }
    if ((match = /^getstate,(\d):(\d)$/.exec(line))) {
      const key = `${match[1]}:${match[2]}`;
      const value = state.relays.has(key) ? state.relays.get(key) : state.sensors.get(key);
      if (value === undefined)
        return errorLine(fam, match[1], match[2], fam === 'flex' ? 'SI001' : '003');
      return `state,${key},${value}`;
    }
    if ((match = /^setstate,(\d):(\d),([0-2])$/.exec(line))) {
      const key = `${match[1]}:${match[2]}`;
      if (!state.relays.has(key)) return errorLine(fam, match[1], match[2], '003');
      state.relays.set(key, Number(match[3]));
      fake.history.push({ key, value: Number(match[3]), conn, at: Date.now() });
      return `state,${key},${match[3]}`;
    }
    if ((match = /^sendir,(\d):(\d),(\d+),/.exec(line))) {
      const key = `${match[1]}:${match[2]}`;
      const mode = state.ir[key];
      if (!mode || mode === 'SENSOR') return errorLine(fam, match[1], match[2], '014');
      if (fake.irBusy.get(key)) return fam === 'itach' ? `busyIR,${key},${match[3]}` : 'ERR IR008';
      fake.irBusy.set(key, true);
      const timer = setTimeout(() => {
        fake.timers.delete(timer);
        fake.irBusy.delete(key);
        send(socket, `completeir,${key},${match[3]}`);
      }, fake.irMs);
      fake.timers.add(timer);
      return undefined;
    }
    if ((match = /^stopir,(\d):(\d)$/.exec(line))) return line;
    return errorLine(fam, 0, 0, '001');
  }

  const server = net.createServer((socket) => {
    if (fake.open >= fake.maxConnections) {
      fake.refused += 1;
      socket.destroy();
      return;
    }
    fake.connections += 1;
    const conn = fake.connections;
    fake.open += 1;
    fake.peak = Math.max(fake.peak, fake.open);
    fake.sockets.add(socket);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let index;
      while ((index = buffer.indexOf('\r')) !== -1) {
        const line = buffer.slice(0, index).replace(/^\n/, '');
        buffer = buffer.slice(index + 1);
        fake.lines.push({ line, conn });
        if (fake.silent) continue;
        const reply = answer(line, conn, socket);
        if (reply !== undefined) send(socket, reply);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      fake.open -= 1;
      fake.sockets.delete(socket);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.port = server.address().port;
  fake.host = `127.0.0.1:${fake.port}`;
  fake.requests = (prefix) =>
    fake.lines.filter((l) => l.line.startsWith(prefix)).map((l) => l.line);
  /** Pushes a line to every connected client (a notification). */
  fake.push = (line) => {
    for (const socket of fake.sockets) socket.write(`${line}\r`);
  };
  fake.close = () =>
    new Promise((resolve) => {
      for (const timer of fake.timers) clearTimeout(timer);
      fake.timers.clear();
      for (const socket of fake.sockets) socket.destroy();
      server.close(() => resolve());
    });
  return fake;
}
