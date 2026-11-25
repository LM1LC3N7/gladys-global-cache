# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-11-25

### Added

- Global Caché gateways (iTach, Flex, GC-100, Global Connect) over the local
  Unified TCP API (port 4998), up to 8 gateways.
- Scene action "Send an infrared code" (Global Caché `sendir` or Pronto
  format), and a button to try a code from the Configuration screen.
- Relays: contact state, "pulse" button (off by default, option "Allow the
  relays"), "release" button never refused; a pulse interrupted by a restart
  is released at the next start (kept in `/data`).
- Sensor inputs, read at the configured interval.
- French and English documentation.

[Unreleased]: https://github.com/LM1LC3N7/gladys-global-cache/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-global-cache/releases/tag/v0.1.1
