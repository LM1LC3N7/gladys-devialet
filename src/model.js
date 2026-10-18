// -----------------------------------------------------------------------------
// Known speakers -> Gladys devices and states (pure). One device per Devialet
// system (one speaker, or a stereo pair), keyed by the serial number of the
// speaker it is reached through: the address may change, the serial does not.
//
// The categories and types are the ones of the Gladys core: `music` like the
// core Sonos service (volume, play, pause, next, previous, playback state),
// `television/volume-mute` for the mute press (music has no mute type),
// `text` for the source and the title, `button/push` for the standby, and the
// power state read only (`unknown/binary`): no switch, nothing an "everything
// on / off" (voice assistants, scenes) could turn into a command. No unit:
// the core lists none for these categories.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE, FEATURES, NOTHING } from './constants.js';
import { INPUTS } from './devialet/inputs.js';

/** The feature definitions, by frozen key. */
export const FEATURE_SPECS = Object.freeze({
  [FEATURES.POWER]: {
    name: 'Power',
    category: C.UNKNOWN,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  },
  [FEATURES.STANDBY]: { name: 'Standby', category: C.BUTTON, type: T.BUTTON.PUSH, min: 0, max: 1 },
  [FEATURES.VOLUME]: {
    name: 'Volume',
    category: C.MUSIC,
    type: T.MUSIC.VOLUME,
    min: 0,
    max: 100,
    has_feedback: true,
  },
  [FEATURES.MUTE]: {
    name: 'Mute',
    category: C.TELEVISION,
    type: T.TELEVISION.VOLUME_MUTE,
    min: 0,
    max: 1,
    has_feedback: true,
  },
  [FEATURES.PLAY]: { name: 'Play', category: C.MUSIC, type: T.MUSIC.PLAY, min: 1, max: 1 },
  [FEATURES.PAUSE]: { name: 'Pause', category: C.MUSIC, type: T.MUSIC.PAUSE, min: 1, max: 1 },
  [FEATURES.NEXT]: { name: 'Next', category: C.MUSIC, type: T.MUSIC.NEXT, min: 1, max: 1 },
  [FEATURES.PREVIOUS]: {
    name: 'Previous',
    category: C.MUSIC,
    type: T.MUSIC.PREVIOUS,
    min: 1,
    max: 1,
  },
  [FEATURES.PLAYBACK]: {
    name: 'Playback',
    category: C.MUSIC,
    type: T.MUSIC.PLAYBACK_STATE,
    min: 0,
    max: 1,
    read_only: true,
  },
  [FEATURES.SOURCE]: {
    name: 'Source',
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    has_feedback: true,
  },
  [FEATURES.TITLE]: {
    name: 'Now playing',
    category: C.TEXT,
    type: T.TEXT.TEXT,
    min: 0,
    max: 0,
    read_only: true,
  },
});

/** The options of the "Source" dropdown: every value this speaker has shown. */
export function sourceOptions(speaker) {
  return (speaker.sourceValues ?? [])
    .filter((value) => Object.hasOwn(INPUTS, value))
    .sort()
    .map((value) => ({ value, label: INPUTS[value] }));
}

export function deviceName(speaker) {
  const name = speaker.systemName || speaker.name || `Devialet ${speaker.serial}`;
  return speaker.model ? `${name} (${speaker.model})` : name;
}

export function buildDevice(gladys, speaker) {
  const ids = gladys.externalIds(DEVICE_TYPE, speaker.serial);
  return {
    name: deviceName(speaker),
    external_id: ids.device,
    should_poll: false,
    params: [{ name: 'IP_ADDRESS', value: speaker.host || '' }],
    // Always the full, fixed list: a device published again never loses a feature.
    features: Object.entries(FEATURE_SPECS).map(([key, { name, ...spec }]) => ({
      name,
      external_id: ids.feature(key),
      read_only: false,
      has_feedback: false,
      keep_history: false,
      ...spec,
      ...(key === FEATURES.SOURCE ? { supported_options: sourceOptions(speaker) } : {}),
    })),
  };
}

/** The feature key of a feature external id of `device`, or undefined. */
export function featureKey(deviceExternalId, featureExternalId) {
  const prefix = `${deviceExternalId}:`;
  return String(featureExternalId ?? '').startsWith(prefix)
    ? String(featureExternalId).slice(prefix.length)
    : undefined;
}

/** "Artist - Title", the title alone, or NOTHING. */
export function nowPlaying(playback) {
  if (!playback || (!playback.title && !playback.artist)) {
    return NOTHING;
  }
  return [playback.artist, playback.title].filter(Boolean).join(' - ');
}

/**
 * The states of a reading `{ on, volume?, playback?, source? }`. `on`
 * undefined (the speaker answered, but not as expected) publishes nothing; an
 * off or unreachable speaker publishes its power only.
 */
export function stateList(gladys, speaker, reading) {
  if (reading.on !== true && reading.on !== false) {
    return [];
  }
  const ids = gladys.externalIds(DEVICE_TYPE, speaker.serial);
  const id = (key) => ids.feature(key);
  const states = [{ device_feature_external_id: id(FEATURES.POWER), state: reading.on ? 1 : 0 }];
  if (!reading.on) {
    return states;
  }
  if (Number.isInteger(reading.volume)) {
    states.push({ device_feature_external_id: id(FEATURES.VOLUME), state: reading.volume });
  }
  const playback = reading.playback;
  if (typeof playback?.muted === 'boolean') {
    states.push({ device_feature_external_id: id(FEATURES.MUTE), state: playback.muted ? 1 : 0 });
  }
  if (typeof playback?.playing === 'boolean') {
    states.push({
      device_feature_external_id: id(FEATURES.PLAYBACK),
      state: playback.playing ? 1 : 0,
    });
  }
  if (reading.playback !== undefined || reading.idle) {
    states.push({ device_feature_external_id: id(FEATURES.TITLE), text: nowPlaying(playback) });
  }
  if (typeof reading.source === 'string') {
    states.push({ device_feature_external_id: id(FEATURES.SOURCE), text: reading.source });
  }
  return states;
}
