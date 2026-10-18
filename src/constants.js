// -----------------------------------------------------------------------------
// Frozen keys (external ids, features, manifest actions), limits and timings.
// Every key here is stored by Gladys or by its users: never rename one.
// -----------------------------------------------------------------------------

/** `gladys.externalIds(DEVICE_TYPE, <serial number of the speaker>)`. */
export const DEVICE_TYPE = 'speaker';

export const FEATURES = Object.freeze({
  /** Read only: 1 the speaker answers, 0 off (standby) or unreachable. */
  POWER: 'power',
  /** Push button: puts the system in standby (there is no "power on" in the API). */
  STANDBY: 'standby',
  VOLUME: 'volume',
  /** Push button: each press sets the opposite of the mute read from the speaker. */
  MUTE: 'mute',
  PLAY: 'play',
  PAUSE: 'pause',
  NEXT: 'next',
  PREVIOUS: 'previous',
  /** Read only: 1 playing, 0 paused. */
  PLAYBACK: 'playback',
  SOURCE: 'source',
  /** Read only: "Artist - Title" of what plays. */
  TITLE: 'title',
});

export const ACTIONS = Object.freeze({
  FIND: 'find_speakers',
  CHECK: 'check_speakers',
});

/** The mDNS service the speakers announce (the one Home Assistant browses). */
export const MDNS_SERVICE = '_devialet-http._tcp';

/** The IP control API listens on plain HTTP. */
export const DEFAULT_PORT = 80;

export const POLL_INTERVAL = Object.freeze({ min: 5, max: 300, default: 10 });

export const TIMINGS = Object.freeze({
  /** One HTTP exchange while polling, probing or searching. */
  httpTimeout: 2_000,
  /**
   * Gladys waits 5 s for the ack of a command: the whole command (wait in the
   * per-speaker queue and every request included) gets `commandBudget`, the
   * state read just before a mute press `preRead` of it.
   */
  commandBudget: 3_800,
  preRead: 1_500,
  /** A speaker that does not answer is asked again after its interval doubled, up to this. */
  maxBackoff: 5 * 60_000,
  /** The source list of a speaker is read again after this. */
  sourcesRefresh: 10 * 60_000,
  /** After a command sent without confirmation (or a standby), the state is read again. */
  recheckDelay: 2_000,
  /** Writes to /data are grouped. */
  persistDelay: 1_000,
  /** mDNS listening time of a search. */
  scanSeconds: 5,
  /**
   * No answer of a search is asked after this (counted from its start, the
   * mDNS listening included), `scanConcurrency` at a time: with the typed
   * addresses asked after, a search ends well within the 60 s of its button.
   */
  scanBudget: 35_000,
  scanConcurrency: 4,
  /** While a created speaker has lost its address, an automatic search this often. */
  autoScanInterval: 10 * 60_000,
  /** Speakers asked at once by "Check the speakers". */
  checkConcurrency: 4,
});

export const LIMITS = Object.freeze({
  speakers: 20,
  addresses: 20,
  /** Sources kept from one answer. */
  sources: 32,
  /** Length of a published title, and of a name. */
  title: 200,
  name: 64,
});

/** What a text feature shows when nothing plays. */
export const NOTHING = '—';
