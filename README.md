# gladys-global-cache

External integration for [Gladys Assistant](https://gladysassistant.com) (5.1.0 or later): Global Caché
gateways (iTach IP2IR/WF2IR/IP2CC/WF2CC, Flex, GC-100, Global Connect) on the local network, through
their official Unified TCP API (port 4998), without any account. **Unofficial, not affiliated with
Global Caché. Never tested with a real device.**

- infrared codes sent from scenes (action "Send an infrared code", Global Caché `sendir` or Pronto
  format), checked against the bounds of the API before anything leaves;
- relays: the state of each contact (read only), a "pulse" push button (closes the contact for the
  pulse length, then opens it), **off by default**, never a switch, and a "release" push button that
  needs neither the option nor a reading first;
- sensor inputs (IR ports set as sensor, sensor modules, Flex Link relay and sensor cable), read only;
- a relay pulse interrupted by a restart is released at the next start, before anything else.

User guide: [français](docs/fr.md) · [English](docs/en.md).

## Development

```bash
npm install
npm test               # node --test (fake Gladys of the SDK, fake gateways on loopback TCP)
npm run lint
npm run format:check
npm run cover          # regenerates cover.png
node scripts/mutants.mjs   # mutation check of the guards (use memcap)
```

Architecture, rules and decisions: [CLAUDE.md](CLAUDE.md) and [TODO.md](TODO.md). Written from the
official "Global Caché Unified TCP API" manual 1.1.2, no third-party code, see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Apache-2.0, see [LICENSE](LICENSE). Global Caché, iTach, Flex and Global Connect are trademarks of their
owner, used here only to say which devices the integration talks to.
