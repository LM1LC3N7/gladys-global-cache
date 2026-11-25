# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for Global Caché gateways (iTach,
Flex, GC-100, Global Connect) over their local Unified TCP API (port 4998): a
Node.js service (Node 22+, ESM, no build step) in its own sandboxed Docker
container, talking to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency.

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/relay.test.js            # one file
npm run lint
npm run format:check
node scripts/mutants.mjs                  # mutation check of the guards (one at a time, use memcap)
```

## Architecture

```
index.js                          SDK wiring only: boot (/data releases), handlers, connect()
src/handlers.js                   the SDK handlers, shared with the tests; getConfig() retried without end
src/app.js                        GlobalCacheApp: configuration, gateways, /data releases, Discovery, states, status
src/gateway.js                    one gateway: jobs one at a time (reading, command, release), pulse, release, IR
src/link.js                       one TCP connection: one request at a time, bounded lines, "sent or not"
src/protocol.js                   the Unified TCP API (pure): versions, modules, errors, IR codes (sendir, Pronto)
src/devices.js                    Gladys devices (pure)
src/store.js                      /data: the relay releases still owed
src/events.js                     rate limit of what is published
src/config.js, src/constants.js   normalization, every bound and timing
src/i18n.js                       French and English texts
test/                             node --test, the SDK fake Gladys + test/helpers/fakeGc.js (TCP)
```

Safety rules (see TODO.md "Decisions"): a relay pulse is off by default, a
push button, never a switch; the option is read again right before the
bytes leave; identity, port and relay state are read again on the same
connection right before; the coming release is written in `/data` before the
first byte (not written, nothing sent); the release (opening the contact) is
never refused, goes ahead of everything, cancels the pulses waiting, cuts a
reading at once and a silent command after 1 s, is tried again within its
budget, then kept in `/data`, sent again by the next readings (3 times) and
at every start, before the configuration is read.

## Rules

- **External ids are forever.** The Unified TCP API gives no serial number
  nor MAC address: the id is the configured address (dots and colons turned
  into dashes). The same goes for every key users store: manifest
  `config_schema`, `actions`, scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (0.1.0 was the one exception). `test/manifest.test.js` checks they
  agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading: the Release workflow moves
  the section, and it becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`.
  The catalog `description` holds 10 to 100 characters per language.
  `test/manifest.test.js` ties the manifest to the code: change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests touch loopback only, and every wait in them is bounded.
