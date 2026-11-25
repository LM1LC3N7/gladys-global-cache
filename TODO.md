# TODO

## Decisions

- 2026-11-25 — Version 0.1.0 set by hand (package.json, lock, manifest, docker_image); the Release
  workflow owns it from now on. SDK `^0.16.1` (latest published on 2026-11-25). `gladys_version`
  `>=5.1.0` (scene actions), no `countries` (sold worldwide), no `keywords`. Categories `multimedia`,
  `protocols`, `lighting` (an IR bridge like Broadlink, relays).
- Reference: the official manual "Global Caché Unified TCP API" 1.1.2 (PN 200113-01, effective
  2024-04-25, page updated 2025-04-25), read on 2026-11-25. No library, no code read or ported.
- Transport: the Unified TCP API only (port 4998), spoken by every product line. The "RESTful HTTP
  API" of the Flex was not found in the official library: not used (the Flex speaks TCP too).
- One connection per job (reading, command, release), closed before the next one opens, one request
  in flight (never pipelined): a GC-100 serves a single connection and other apps may need it. A
  connection the gateway closes before saying a word (it may still be freeing the previous one) is
  opened again once, 50 ms later (the first request of a job is always a version read or a release).
- Identity: the API gives no serial nor MAC, the external id is the configured address (dots and
  colons as dashes; two addresses that would share an id: the second is refused). The model read by
  getversion is compared with the `model` param of the created device before every command and at
  every reading: another model = no state published, commands refused, said in the status. An
  unreadable version is never "another device".
- Relays: SPST only (pulse means close then open); Flex SPDT/DPDT logical relays left out. Pulse:
  button, off by default (`allow_relays`), option read again in `beforeSend`; model, modules (and the
  Flex relay type) and the relay state read on the same connection right before (read closed =
  refused); the coming release written in `/data` and awaited (2 s at most, not written = nothing
  sent); `setstate,<m>:<p>,1`; the release timer starts at the first byte, whatever the answer. The
  `period` parameter of setstate is not used (not documented for every product line): the module
  releases the relay itself.
- Release (protective): never refused (no option, no config, no identity); ahead of every job; cancels
  the pulses of that relay waiting (a number bumped at each release, checked in `beforeSend`); cuts a
  reading at once (not a failure) and a command silent for 1 s; confirmed by a getstate read after it;
  retried within 250 ms (3 attempts), then kept in `/data`, sent again by the next 3 successful readings
  and at every start (`app.boot()`, before the configuration is read). A release of a gateway removed
  from the configuration still goes (its gateway object lives until idle). At stop, held relays are
  released (1 s real time at most).
- IR: codes checked against the manual bounds (15–500 kHz, GC-100 ≥ 20 kHz, repeat ≤ 20 — the lowest
  of the product lines —, pairs, 1–50000, odd offset, 512 values, 5 s of transmission); our own ID
  (1–65535); port mode read again (get_IR) right before, except on Flex (its port parameter means the
  cable); completeir awaited (length + 1.5 s); busyIR/ERR = refused; no answer = "sent, without
  confirmation" (`confirmed: false`, the scene goes on). Pronto learned codes (0000) converted;
  compressed GC format refused.
- Readings: every `poll_interval` (10–3600 s, default 30), from the start of the previous one; never
  doubled; cut by any command. getversion, getdevices, get_IR per IR port (sensor mode = input),
  get_RELAY (Flex), getstate per relay and input; 48 requests at most; a line is 256 bytes at most,
  64 lines per request. States published only for a created device, only on change, 300 per minute
  at most; `connected` and a saved configuration forget the published values (fresh readings only).
  A saved configuration or a reconnection reads nothing sooner; the test button reads only if the last
  reading is 5 s old. A local gateway has no quota: a restart reads at once (no date in `/data`).
- `/data`: only the releases owed (address, module, port, date); read bounded (2 s, 64 KB, regular
  file, no link); unreadable is never overwritten (pulses refused), read again every 10 s.

## Later

- Confirm on a real device: the GC-100 answer to `getversion` without module, getdevices of a Flex
  with the relay and sensor cable (`RELAYSENSOR`?), the sensor ports of module 2, busyIR format, how
  fast a GC-100 frees its connection.
- TCP change notifications (`getstate,<m>:<p>,notify`, GC-100 `statechange`) on a held connection,
  for inputs faster than the interval.
- Compressed GC IR format; a library of named codes in the configuration.
- Mutation check of the guards: `memcap node scripts/mutants.mjs` (scripts/mutants.json).
