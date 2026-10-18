# TODO — Devialet v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only.

## Status

- [x] **Milestone 1 — local control** (2026-10-18): speakers added by IP
      address or found by mDNS (`scanNetwork('mdns')`, optional), identity by
      serial number, one device per system; power state, standby, volume,
      mute, play/pause/next/previous, playback state, source dropdown, title;
      spaced retries for a speaker that does not answer; "Find" and "Check"
      buttons; docs en/fr. Tested against a fake speaker on the loopback
      interface only, never with a real speaker.
- [ ] **Milestone 2 — real speakers** (testers with a Phantom): record real
      answers as fixtures, fix what differs. To check first:
  - does a Phantom in standby answer the IP control API at all? Today
    "nothing accepts the connection" is shown as power 0 (standby, off or
    unreachable). If a speaker in standby answers, read its standby state
    (`devices/current` may carry it) instead;
  - is there any way to wake a speaker through the API (none in the devialet
    library nor in Home Assistant, which offer "turn off" only)? If so, the
    standby button could become a power state + "turn on" button;
  - the error answered by `groups/current/sources/current` when nothing
    plays (shown as "—" today, playback state not published);
  - the answers of a stereo pair and of a group of systems (which speaker
    answers the volume of a pair, what `groups/current` returns for each
    member), the `role` values of the Phantom II and of the Dialog / Arch;
  - the port and the TXT records of the mDNS service `_devialet-http._tcp`
    as relayed by Gladys;
  - the mute endpoints when no source plays;
  - the rendering on the Gladys dashboard (not checked: no Gladys front
    here): the `music` play/pause/next/previous buttons (min = max = 1, as
    the core Sonos service), the `television/volume-mute` press with its
    state, the `button/push` Standby, the `unknown/binary` power, the
    `text/select` Source and the `text/text` title. Check that each shows as
    a button or a state as intended, and what value each button sends.
- [ ] **Milestone 3 — more**: equalizer and night mode (the library has
      them), volume up/down buttons, notifications through UPnP
      (`music/play_notification`, as the core Sonos service does), a
      "forget a speaker" action.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, then the store validator once the image is published.

## Decisions

- Forum: no dedicated topic, no post from this module's work; one recap per
  wave in /t/10385, posted by the main session.
- Reuse: fwestenberg/devialet 1.5.7 (MIT) is Python (aiohttp), so its
  endpoints, source names and stereo-pair source logic (`source_list`,
  `source`, `async_select_source`) are ported to JavaScript
  (`src/devialet/`); MIT notice in `THIRD_PARTY_NOTICES.md`, copied into the
  image. The UPnP part of the library (play a URL) is not ported in v1. The
  Home Assistant integration was read for the discovery (service
  `_devialet-http._tcp`, serial number as unique id). No runtime dependency
  besides the SDK (node:http is built in).
- Version 0.1.0 in `package.json`, `package-lock.json`, the manifest and the
  `docker_image` tag, set by hand at milestone 1: the one exception to
  "versions belong to the Release workflow", because the template's 1.0.0 and
  its image were someone else's. The first patch release gives 0.1.1.
- External ids: `gladys.externalIds('speaker', <serial number>)`, never the
  address. Feature keys are frozen: `power`, `standby`, `volume`, `mute`,
  `play`, `pause`, `next`, `previous`, `playback`, `source`, `title`. Every
  publication carries the full, fixed feature list (a device published again
  never loses a feature); only the source options grow.
- **Power: read-only state + `button/push` "Standby", not a `switch`.** The
  IP control API has no "power on" (the library and Home Assistant only turn
  off): a switch would offer an "on" that cannot work. With a button, an
  "everything off" (voice assistants, `switch.*` scenes) does NOT put the
  speakers in standby; this was the brief's acceptable alternative, and it
  keeps the lesson of lot 6 (no switch for a command an "everything on/off"
  could fire). The power state is `unknown/binary`, read only (1 the speaker
  answers, 0 nothing accepts the connection). Standby on a speaker that does
  not answer sends nothing and is not an error.
- Categories and types from the core only (`server/utils/constants.js`):
  `music` for volume, play, pause, next, previous and playback state (as the
  core Sonos service), `television/volume-mute` for mute (music has no mute
  type), `text/select` and `text/text`, `button/push`, `unknown/binary`. No
  unit: `DEVICE_FEATURE_UNITS_BY_CATEGORY` lists none for music, television,
  text, button or unknown. Store category `multimedia`.
- Mute is a push (Gladys sends a press, not a target): the mute is read from
  the speaker just before (1.5 s at most) and the explicit `mute` or `unmute`
  endpoint is sent, never a toggle. Unknown mute state: nothing sent. Not a
  switch: an "everything off" would unmute.
- Volume validated strictly before queueing: an integer 0..100 as a number or
  a string of digits; null, '', booleans, 12.5, '12abc', NaN refused.
- Source: the select values are the library's source types (frozen), the
  optical inputs of a stereo pair suffixed by side. The options are the
  values the speaker has shown, kept in `/data` and only growing. A command
  is checked against the options, then the source id is read again from the
  speaker (never trusted from Gladys) and sent URL-encoded.
- Systems and groups: one Gladys device per `systemId` (the one already
  created, else the leader, else the lowest serial). Volume and standby go to
  `systems/current`, playback, mute and source to `groups/current` (the whole
  group), as the library does.
- Reachability: a refused connection, no route or a connection never accepted
  is "standby, off or unreachable": power 0, named in the status message,
  read again after the interval doubled each time (5 minutes at most), never
  faster than the interval; a start or configuration save skips the backoff,
  not the interval. A connection accepted then silent, an HTTP error or an
  unreadable answer is unknown (nothing published, normal interval). When a
  speaker answers again, the serial at its address is read first: another
  speaker there clears the address (DHCP), never commanded there. The status
  stays "connected" (local integration, no account).
- Commands: serialized per speaker, budget 3.8 s from the Gladys request (the
  wait in the queue included), each request bounded by what is left; a
  command still queued at its deadline is dropped, never sent late. A
  request that may have reached the speaker (connected then silent) is
  answered "sent, without confirmation" and the state read again 2 s later;
  a speaker that does not accept the connection gets "nothing sent".
- Hostile answers: 64 KB read at most, `JSON.parse` once, only the expected
  fields of the expected types kept, strings cleaned (control and bidi
  characters) and cut (200 characters for the title, 64 for names), ids and
  error codes kept only when they are plain identifiers, 32 sources at most,
  20 speakers at most, 50 mDNS results at most. No redirect followed.
- On every (re)connection to Gladys: the status cache is cleared and
  `forgetPublishedStates()` called, then the last readings published again
  and the speakers read.
- Polling 5 s to 300 s (default 10 s), own timer (`should_poll: false`):
  only the created speakers; states through `publishChangedStates`.
- Text features show "—" when nothing plays.

### Review fixes (2026-10-18)

- Prototype pollution: the speaker table (`data.speakers`) is
  `Object.create(null)` in `emptyData` and `sanitize`; every read by serial
  goes through `Object.hasOwn`; `__proto__`, `constructor` and `prototype` are
  refused as serial and as any id (`isSafeId`, source ids too), from the
  network and from `/data`.
- Acks: the states a command implies are published in the background
  (`publishPartial` not awaited in the queue task). A `mayHaveSent` flag is
  set just before each command request (cleared when the connection was never
  accepted); at the deadline, set means "Sent, without confirmation" plus a
  re-read, unset means "nothing sent". The reads before a command (mute state,
  source ids) never trigger a re-read and always mean "nothing sent".
- Created devices: from `getDevices`, else from `gladys.devices` (the SDK's
  list); while the last `getDevices` failed, it is called again at every
  round.
- Lost address: a created speaker without an address is polled without any
  request (power 0) and named in the status ("address unknown, run Find the
  speakers"); while one exists, a search runs by itself every 10 minutes, in
  the background (the polling does not wait for it).
- Searches: one at a time (a second request joins the running one), answers
  identified 4 at a time, none started after 35 s from the start: with the
  typed addresses after it, a search ends within the 60 s of the button.
- Reads spaced out on HTTP, API and unreadable answers too (typed addresses
  and speakers), like no answer, without publishing power 0.
- Identity (`devices/current`) and system name read again every 10 minutes,
  on their own timestamp (`identityReadAt`, independent of the source list);
  a new name republishes the device.
- The devices are published again whenever the set of created speakers
  changes (refreshCreated, device created, device deleted).
- A search checks the generation: after stop() it identifies nothing more and
  publishes nothing; no automatic search starts while stopped.
- Source options: merged with the `supported_options` of the created device
  (`gladys.devices`) before every publication.
- Unprintable characters are given as code point ranges (C0, DEL, C1,
  U+061C, U+200E-U+200F, U+2028-U+202E, U+2066-U+2069), not as a regular
  expression of invisible characters.
