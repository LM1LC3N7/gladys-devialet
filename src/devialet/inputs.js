// -----------------------------------------------------------------------------
// The sources of a Devialet system and how they are named, ported from the
// devialet library (MIT, see THIRD_PARTY_NOTICES.md): `NORMAL_INPUTS`,
// `SPEAKER_POSITIONS`, and the `source_list` / `source` / `async_select_source`
// logic that tells apart the optical inputs of the two speakers of a stereo
// pair. Pure functions: every answer of the speaker is untrusted here.
// -----------------------------------------------------------------------------

/** Source value (frozen: stored in Gladys as the select value) -> label. */
export const INPUTS = Object.freeze({
  airplay2: 'AirPlay',
  bluetooth: 'Bluetooth',
  digital_left: 'Digital left',
  digital_right: 'Digital right',
  line: 'Line',
  upnp: 'UPnP',
  optical: 'Optical',
  optical_left: 'Optical left',
  optical_right: 'Optical right',
  opticaljack: 'Optical jack',
  opticaljack_left: 'Optical jack left',
  opticaljack_right: 'Optical jack right',
  phono: 'Phono',
  raat: 'Roon Ready (RAAT)',
  spotifyconnect: 'Spotify Connect',
});

/** The role a stereo speaker reports -> the suffix of its optical inputs. */
export const SPEAKER_POSITIONS = Object.freeze({ FrontLeft: 'left', FrontRight: 'right' });

const OPTICAL = new Set(['optical', 'opticaljack']);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const SAFE_TYPE = /^[a-z0-9_]{1,32}$/;

const str = (value) => (typeof value === 'string' ? value : undefined);

/**
 * The sources of `GET /groups/current/sources`, kept only when well formed:
 * `[{ sourceId, deviceId, type }]`, at most `limit`.
 */
export function parseSources(json, limit) {
  const list = Array.isArray(json?.sources) ? json.sources : [];
  const sources = [];
  for (const source of list) {
    const sourceId = str(source?.sourceId);
    const deviceId = str(source?.deviceId);
    const type = str(source?.type);
    if (
      SAFE_ID.test(sourceId ?? '') &&
      SAFE_ID.test(deviceId ?? '') &&
      SAFE_TYPE.test(type ?? '')
    ) {
      sources.push({ sourceId, deviceId, type });
      if (sources.length >= limit) {
        break;
      }
    }
  }
  return sources;
}

/**
 * The value of one source as the speaker at `self` sees it: the optical input
 * of a stereo speaker gets the side it belongs to (its own side when the
 * source is on this speaker, the other side when it is on its partner).
 */
export function sourceValue(source, self) {
  let value = source.type;
  if (OPTICAL.has(value) && Object.hasOwn(SPEAKER_POSITIONS, self.role ?? '')) {
    for (const [role, position] of Object.entries(SPEAKER_POSITIONS)) {
      const mine = source.deviceId === self.deviceId;
      if ((mine && role === self.role) || (!mine && role !== self.role)) {
        value = `${value}_${position}`;
      }
    }
  }
  return value;
}

/** The known source values of a source list, sorted, without duplicates. */
export function sourceValues(sources, self) {
  const values = new Set();
  for (const source of sources) {
    const value = sourceValue(source, self);
    if (Object.hasOwn(INPUTS, value)) {
      values.add(value);
    }
  }
  return [...values].sort();
}

/** The value of the source that plays (`GET /groups/current/sources/current`), or undefined. */
export function currentSourceValue(state, sources, self) {
  const sourceId = str(state?.source?.sourceId);
  const deviceId = str(state?.source?.deviceId);
  const source = sources.find((s) => s.sourceId === sourceId && s.deviceId === deviceId);
  if (!source) {
    return undefined;
  }
  const value = sourceValue(source, self);
  return Object.hasOwn(INPUTS, value) ? value : undefined;
}

/** The sourceId to play for a source value, or undefined when this system has none. */
export function sourceIdFor(value, sources, self) {
  if (!Object.hasOwn(INPUTS, value)) {
    return undefined;
  }
  const [type, position] = value.split('_');
  if (position !== undefined && OPTICAL.has(type)) {
    const role = Object.keys(SPEAKER_POSITIONS).find((r) => SPEAKER_POSITIONS[r] === position);
    const wantMine = role === self.role;
    return sources.find((s) => s.type === type && (s.deviceId === self.deviceId) === wantMine)
      ?.sourceId;
  }
  return sources.find((s) => s.type === value)?.sourceId;
}
