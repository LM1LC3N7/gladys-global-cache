# Global Caché

This integration brings the Global Caché gateways of your network to Gladys: iTach (IP2IR, WF2IR,
IP2CC, WF2CC), Flex, GC-100 and Global Connect. It uses the official Global Caché Unified TCP API
(port 4998), locally, without any account or cloud.

**Unofficial integration, not affiliated with Global Caché. Written from the official "Unified TCP API"
manual 1.1.2, it was never tested with a real device**: your feedback is welcome.

## What it does

- **Infrared codes** from scenes: action "Send an infrared code" (gateway, connector, code).
- **Relays** (iTach IP2CC/WF2CC, GC-100-12/18, Flex with the relay and sensor cable, Global Connect
  Relay): the contact state (read only), a "pulse" button and a "release" button.
- **Inputs** (IR port set as sensor, sensor module, Flex relay and sensor cable): read at the chosen
  interval (30 s by default).

## Setup

1. Give every gateway a **fixed address** (DHCP reservation): the API gives no serial number nor MAC
   address, so the address is the identity of the gateway in Gladys. Another address would make a new
   device.
2. In the configuration, enter the addresses (e.g. `192.168.1.70, 192.168.1.71`), 8 at most. Add
   `:port` only if it is not 4998.
3. Save, then open **Discovery** and add the gateways.

The integration opens one connection per reading or command and closes it at once: a GC-100, which
accepts a single connection at a time, stays available to your other apps between two exchanges.

## Infrared codes

In a scene, choose the action "Send an infrared code", the gateway, the connector (`module:port`, e.g.
`1:1` on an iTach, `4:2` on a GC-100; the outputs are listed in the device params, `ir_ports`) and the
code. Accepted formats:

- a whole `sendir` line: `sendir,1:1,1,38000,1,1,342,171,21,21,...` (its connector is used when the
  field is empty; when it differs from the field, nothing is sent);
- the same without its start: `38000,1,1,342,171,21,21,...` (frequency, repeats, offset, durations);
- a learned Pronto code (`0000 006D 0000 0022 ...`), converted by the integration (the other Pronto
  kinds, `0100`, `5000`…, are not).

The compressed Global Caché format (with letters) is not supported. Codes are found in the Global Caché
Control Tower database or learned with the iLearn tool.

Before sending, the integration checks the code against the bounds of the manual: frequency 15,000 to
500,000 Hz (20,000 at least for a GC-100); 1 to 20 repeats; odd offset, 383 at most (255 on a GC-100);
durations in pairs, 50,000 at most, each of 80 µs at least (and 4 at least on Flex and Global
Connect); 512 durations at most; 5 s of transmission at most, repeats included. It then reads the
identity of the gateway and the port mode again: a port set as sensor sends nothing. The action returns `confirmed` (end
of transmission confirmed by the gateway). Without that confirmation the code may have left: the scene
goes on and the variable is false. The "Try an infrared code" button of the configuration does the
same.

## Relays

A relay may drive a gate, a garage door or a blind. Every relay gives three features:

- **Relay 1:1 (contact)**: 1 contact closed, 0 open, read at every reading;
- **Relay 1:1: pulse**: closes the contact for the "Pulse length" (500 ms by default, 100 to
  10,000 ms), then opens it;
- **Relay 1:1: release**: opens the contact now.

They are buttons, never switches: a "turn everything off" or "on" scene does not touch them. Only
simple relays (SPST) are offered; on a Flex, a relay configured as SPDT or DPDT is not offered.

### The pulse, off by default

The pulse is refused, with nothing sent to the relay, in these cases:

- the "Allow the relays" option is unchecked (it is read again right before sending);
- `/data` is unreadable, or could not keep the coming release (2 s at most);
- a pulse of this relay is under way, or its release is not confirmed yet;
- a release (of this relay or another one of the gateway) was asked before the first byte of the
  pulse: it goes first;
- the gateway is not created in Gladys yet, or another model answers at its address;
- the port is no longer a simple relay of the gateway;
- the relay reads closed right before;
- the gateway is unreachable, answers unexpectedly or too slowly (Gladys waits 5 s);
- 8 commands already wait for this gateway;
- the integration is stopping (from the start of the stop).

Right before sending, the integration reads again, on the same connection, the gateway model, its
modules and the relay state, then writes the coming release in `/data`. The release leaves after the
pulse length, even if the gateway did not answer the pulse.

On a GC-100, which accepts a single connection at a time, the pulse keeps its connection for its length
and its release goes on that same connection: no other app can take it in between. The other commands
to that GC-100 wait for the end of the pulse, but not beyond their own delay (3.3 s for a pulse, 12 s
for an infrared code): they are then refused with nothing sent. A release goes at once on the kept
connection.

### The release

The release (opening the contact) depends neither on the option, nor on a configuration
not read yet, nor on a reading or a command under way; it only needs the address of the gateway, which
the device carries. It goes ahead of everything: it cancels the pulses
of that relay still waiting, cuts at once a reading or a command that wrote nothing yet, and cuts a
command already sent once the gateway said nothing for 1 s. It is confirmed by a reading of the relay made after it.

It fails only when the gateway does not answer, or when the stop of the integration lasts more than
2 s. It is then kept in `/data` and in memory, sent again on a timer of its own (1 s, 2 s, 5 s, 10 s,
30 s, then every minute, until confirmed), at every successful reading of the gateway and at every
start of the integration (before the configuration is even read); the status says so. When `/data` is
unreadable it is kept in memory only (and sent again the same way): a restart would lose it, the
status says so.

When the integration stops, no pulse leaves any more; every relay held, being pulsed or with a release
waiting is released (2 s at most). A release that could not leave stays in `/data` and goes at the next
start.

## Status

The configuration screen shows, per gateway, the model, the number of relays and inputs, the last
command, and the releases not confirmed yet. The "Test the gateways" button reads every gateway again
(at most once every 5 s).

## Limits

- Inputs and relays are read at the interval (10 s at least): a shorter change may go unseen. The TCP
  and UDP notifications of the gateways are not used.
- Serial port (IP2SL, Flex serial) and HDMI switch not supported.
- The RESTful HTTP API of the Flex is not used: the Flex also speaks the Unified TCP API.
