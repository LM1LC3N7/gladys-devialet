# gladys-devialet

[Gladys Assistant](https://gladysassistant.com) external integration for
**Devialet Phantom** speakers, on the local network: volume, mute, source,
play, pause, next, previous, the title playing and standby, through the IP
control API of the speakers (`http://<ip>/ipcontrol/v1/...`), without any
cloud. Unofficial, not affiliated with Devialet.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Work in progress.** First milestone, tested against a fake speaker only,
> never with a real Devialet speaker.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (DevialetApp)
                                   ├─ src/devialet/client.js  one speaker: endpoints, parsing of untrusted answers
                                   ├─ src/devialet/inputs.js  source names, stereo-pair optical inputs (pure, ported)
                                   ├─ src/devialet/http.js    node:http, no keep-alive, bounded time and size (64 KB)
                                   ├─ src/model.js            known speakers -> Gladys devices and states (pure)
                                   └─ src/store.js            /data/devialet.json: known speakers, their sources
```

- **Speakers** are added by IP address (configuration), or found with
  `gladys.scanNetwork('mdns')` (service `_devialet-http._tcp`, optional: a
  failure never blocks). Each speaker is identified by the serial number of
  `GET /devices/current` (external id `speaker:<serial>`); the speakers of a
  stereo pair (same `systemId`) give one device: the one already created,
  else the system leader.
- **Polling** (own timer, 5 to 300 s): `groups/current/sources/current`
  (playing state, mute, metadata, source), `groups/current/sources` (every 10
  minutes), `systems/current/.../soundControl/volume`. A refused connection
  or no answer at all means "standby, off or unreachable" (power 0, named in
  the status), then reads spaced out (interval doubled each time, 5 minutes at
  most). Connected then silent, or an unexpected answer: unknown, nothing
  published.
- **Commands**: validated first (volume an integer 0..100, source among the
  dropdown options), serialized per speaker, each within a 3.8 s budget (Gladys
  acks in 5 s), dropped when they cannot start in time. Mute is a press: the
  state is read just before and the explicit `mute` / `unmute` endpoint is
  sent. A source is played by the source id read again from the speaker. A
  request that may have reached the speaker is reported "sent, without
  confirmation" and the state read again.
- **Features**: `music` (volume, play, pause, next, previous, playback state)
  like the core Sonos service, `television/volume-mute`, `text/select`
  (source), `text/text` (title), `button/push` (standby) and a read-only
  `unknown/binary` power state. No switch: the API has no "power on".

## Development

```bash
npm install
npm test                                        # node --test, loopback only (fake speaker)
npm run lint && npm run format:check
npm run audit
npm run cover                                   # regenerates cover.png (800×534, no dependency)
npx github:GladysAssistant/integration-store .  # store admission checks
```

`test/fixtures/fakeSpeaker.js` is a fake speaker on 127.0.0.1 (the endpoints
used, plus silent, hostile and idle modes). The end-to-end tests run the real
handlers against the SDK's fake Gladys.

## Credits

- [`devialet`](https://github.com/fwestenberg/devialet) 1.5.7 by fwestenberg
  (MIT), the library behind the Home Assistant Devialet integration: the
  endpoints, the source names and the stereo-pair source logic are ported
  from it to JavaScript.
- The Home Assistant Devialet integration (Apache-2.0) was consulted for the
  mDNS discovery (service type, serial number as identity).
- The app structure follows
  [LM1LC3N7/gladys-panasonic-viera](https://github.com/LM1LC3N7/gladys-panasonic-viera)
  and [LM1LC3N7/gladys-denon-avr](https://github.com/LM1LC3N7/gladys-denon-avr)
  (same author, Apache-2.0).

Devialet and Phantom are trademarks of Devialet, used here only to name the
compatible products.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic is added at the first real release.

## License

Apache-2.0, see [LICENSE](LICENSE). Third-party notices (devialet, MIT):
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
