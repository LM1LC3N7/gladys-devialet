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
