# Third-party notices

This integration bundles no third-party code and ports none. It talks to the
Global Caché gateways through the protocol described in the official manual
"Global Caché Unified TCP API", version 1.1.2 (PN 200113-01, effective
2024-04-25, <https://www.globalcache.com/library/unified-api/>, read on
2026-11-25): the requests, their parameters and ranges, the answers, the
error codes and the IR code format come from that manual. No text of the
manual is copied. The conversion of Pronto learned codes (`0000` format) uses
the public definition of that format (frequency word, once and repeat burst
pairs).

Its only runtime dependency is `@gladysassistant/integration-sdk` (Apache-2.0),
installed from npm.

Global Caché, iTach, Flex and Global Connect are trademarks of their owner,
named only to say which devices the integration talks to. This project is not
affiliated with Global Caché.
