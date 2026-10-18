// -----------------------------------------------------------------------------
// The IP control API of one Devialet speaker (`http://<ip>/ipcontrol/v1/...`),
// the endpoints of the devialet library (MIT, see THIRD_PARTY_NOTICES.md).
// `devices/current` is the speaker itself, `systems/current` the system it
// belongs to (one speaker or a stereo pair: volume, standby), `groups/current`
// the group of systems playing together (playback, mute, source).
//
// Every answer is untrusted: bounded in size (http.js), parsed once, and only
// the expected fields of the expected types are kept, strings cut and cleaned.
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';
import { ERROR_KINDS, SpeakerError, request as defaultRequest } from './http.js';
import { parseSources } from './inputs.js';

const BASE = '/ipcontrol/v1';
export const PATHS = Object.freeze({
  DEVICE: `${BASE}/devices/current`,
  SYSTEM: `${BASE}/systems/current`,
  POWER_OFF: `${BASE}/systems/current/powerOff`,
  VOLUME: `${BASE}/systems/current/sources/current/soundControl/volume`,
  SOURCES: `${BASE}/groups/current/sources`,
  CURRENT: `${BASE}/groups/current/sources/current`,
  PLAY: `${BASE}/groups/current/sources/current/playback/play`,
  PAUSE: `${BASE}/groups/current/sources/current/playback/pause`,
  NEXT: `${BASE}/groups/current/sources/current/playback/next`,
  PREVIOUS: `${BASE}/groups/current/sources/current/playback/previous`,
  MUTE: `${BASE}/groups/current/sources/current/playback/mute`,
  UNMUTE: `${BASE}/groups/current/sources/current/playback/unmute`,
  playSource: (sourceId) =>
    `${BASE}/groups/current/sources/${encodeURIComponent(sourceId)}/playback/play`,
});

// Control characters (C0, DEL, C1) and the bidirectional overrides are
// removed from what is shown in Gladys.
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** A printable string of at most `max` characters, or undefined. */
export function cleanText(value, max) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value
    .slice(0, max * 4)
    .replace(UNPRINTABLE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text === '' ? undefined : [...text].slice(0, max).join('');
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const safeId = (value) => (typeof value === 'string' && SAFE_ID.test(value) ? value : undefined);
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/** `GET devices/current` -> who the speaker is. Throws without a usable serial number. */
export function parseDevice(json) {
  const serial = safeId(json?.serial);
  if (!serial) {
    throw new SpeakerError(ERROR_KINDS.PROTOCOL, 'Not a Devialet speaker (no serial number)');
  }
  return {
    serial,
    deviceId: safeId(json.deviceId),
    systemId: safeId(json.systemId),
    groupId: safeId(json.groupId),
    name: cleanText(json.deviceName, LIMITS.name),
    model: cleanText(json.model, LIMITS.name),
    role: safeId(json.role),
    leader: json.isSystemLeader === true,
    version: cleanText(json.release?.version, LIMITS.name),
  };
}

/**
 * `GET groups/current/sources/current` -> what plays. Every field is
 * optional: undefined means "not said", never a guess.
 */
export function parsePlayback(json) {
  const playing = json?.playingState;
  const mute = json?.muteState;
  const metadata = json?.metadata && typeof json.metadata === 'object' ? json.metadata : {};
  const operations = Array.isArray(json?.availableOperations)
    ? json.availableOperations.filter((op) => typeof op === 'string').slice(0, 32)
    : undefined;
  return {
    playing: playing === 'playing' ? true : playing === 'paused' ? false : undefined,
    muted: mute === 'muted' ? true : mute === 'unmuted' ? false : undefined,
    artist: cleanText(metadata.artist, LIMITS.title),
    title: cleanText(metadata.title, LIMITS.title),
    source: {
      sourceId: safeId(json?.source?.sourceId),
      deviceId: safeId(json?.source?.deviceId),
    },
    operations,
  };
}

/** `GET .../soundControl/volume` -> an integer 0..100, or undefined. */
export function parseVolume(json) {
  const volume = json?.volume;
  return typeof volume === 'number' && Number.isFinite(volume) && volume >= 0 && volume <= 100
    ? Math.round(volume)
    : undefined;
}

export class DevialetClient {
  constructor({ host, port, request = defaultRequest, timeoutMs = 2000, deadline, now }) {
    this.host = host;
    this.port = port;
    this.request = request;
    this.timeoutMs = timeoutMs;
    /** Wall-clock end of the budget of a command (withBudget), or undefined. */
    this.deadline = deadline;
    this.now = now ?? Date.now;
  }

  /** A copy of this client whose requests all end within `ms` from now. */
  withBudget(ms) {
    return new DevialetClient({
      host: this.host,
      port: this.port,
      request: this.request,
      timeoutMs: this.timeoutMs,
      deadline: this.now() + Math.max(0, ms),
      now: this.now,
    });
  }

  timeout() {
    if (this.deadline === undefined) {
      return this.timeoutMs;
    }
    const left = this.deadline - this.now();
    if (left < 50) {
      throw new SpeakerError(ERROR_KINDS.BUDGET, 'No time left for this request');
    }
    return Math.min(this.timeoutMs, left);
  }

  /** One exchange; the parsed JSON object of a 2xx answer, a SpeakerError otherwise. */
  async call(method, path, body) {
    const timeoutMs = this.timeout();
    const answer = await this.request({
      host: this.host,
      port: this.port,
      method,
      path,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      timeoutMs,
    });
    let json;
    const text = answer.body.trim();
    if (text !== '') {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    const error = json && typeof json === 'object' ? json.error : undefined;
    if (error !== undefined && error !== null) {
      const code = typeof error?.code === 'string' && SAFE_CODE.test(error.code) ? error.code : '?';
      throw new SpeakerError(ERROR_KINDS.API, `Speaker error ${code}`, {
        code,
        status: answer.status,
      });
    }
    if (answer.status < 200 || answer.status > 299) {
      throw new SpeakerError(ERROR_KINDS.HTTP, `HTTP ${answer.status}`, { status: answer.status });
    }
    if (text !== '' && (json === null || typeof json !== 'object' || Array.isArray(json))) {
      throw new SpeakerError(ERROR_KINDS.PROTOCOL, 'Unexpected answer (not a JSON object)');
    }
    return json ?? {};
  }

  get(path) {
    return this.call('GET', path);
  }

  post(path, body) {
    return this.call('POST', path, body);
  }

  async describe() {
    return parseDevice(await this.get(PATHS.DEVICE));
  }

  /** The name of the system (a stereo pair has one), or undefined. */
  async systemName() {
    const json = await this.get(PATHS.SYSTEM);
    return cleanText(json.systemName, LIMITS.name);
  }

  async sources() {
    return parseSources(await this.get(PATHS.SOURCES), LIMITS.sources);
  }

  async playback() {
    return parsePlayback(await this.get(PATHS.CURRENT));
  }

  async volume() {
    return parseVolume(await this.get(PATHS.VOLUME));
  }

  /** `volume` must already be validated (an integer 0..100). */
  setVolume(volume) {
    return this.post(PATHS.VOLUME, { volume });
  }

  setMute(muted) {
    return this.post(muted ? PATHS.MUTE : PATHS.UNMUTE);
  }

  play() {
    return this.post(PATHS.PLAY);
  }

  pause() {
    return this.post(PATHS.PAUSE);
  }

  next() {
    return this.post(PATHS.NEXT);
  }

  previous() {
    return this.post(PATHS.PREVIOUS);
  }

  powerOff() {
    return this.post(PATHS.POWER_OFF);
  }

  playSource(sourceId) {
    return this.post(PATHS.playSource(sourceId));
  }
}
