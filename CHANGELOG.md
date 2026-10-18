# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Devialet Phantom speakers over their local IP control API, without any
  cloud: added by IP address, or found with an optional mDNS search through
  Gladys, and kept by their serial number when their address changes. One
  Gladys device per Devialet system (a stereo pair typed twice is shown once).
- Volume (0 to 100, validated strictly before anything is sent), mute (each
  press reads the mute from the speaker and sets the opposite), play, pause,
  next, previous, playback state, a "Source" dropdown read and set (stereo-pair
  optical inputs by side), the title playing, and a standby button. Every
  command is answered to Gladys within 5 seconds, or dropped, never sent late.
- A speaker in standby, off or unreachable shows its power at 0 and is named
  in the integration status; it is asked again at spaced intervals (5 minutes
  at most). Answers are read with a 64 KB limit and only the expected fields
  are kept.
- "Find the speakers" and "Check the speakers" buttons.
- A created speaker whose address went to another speaker shows its power at
  0, is named in the status ("address unknown, run Find the speakers"), and a
  search runs by itself every 10 minutes until it is found again.

### Fixed

- A command the speaker accepted is no longer reported as failed when Gladys
  is slow to take the states; a command whose request may have left is
  answered "sent, without confirmation" at the deadline, "nothing sent" only
  when no request left, and no needless re-read after a pre-read timeout.
- The speakers are still read when the list of the Gladys devices cannot be
  fetched at start (the SDK's list is used, the fetch is retried every round).
- Answers that are HTTP errors or unreadable are asked again at spaced
  intervals; the identity and the system name are read again every 10
  minutes; the Source options of a created device are never dropped.
- One search at a time, its answers asked 4 at a time within 35 seconds.

### Security

- A serial number or an id `__proto__`, `constructor` or `prototype` from the
  network or from `/data` is refused: the speaker table has no prototype.
- More invisible characters are removed from the texts (bidi marks U+200E,
  U+200F, U+061C, and the separators U+2028, U+2029).
