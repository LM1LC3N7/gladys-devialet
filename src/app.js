// -----------------------------------------------------------------------------
// The integration: the Devialet speakers it knows (typed addresses, optional
// mDNS search through Gladys), the Gladys devices built from them, the polling
// (spaced out for a speaker that does not answer), the commands (validated
// before anything is sent, serialized per speaker, each within the 5 s Gladys
// waits for its ack) and the configuration screen buttons. index.js only wires
// the SDK handlers to it (src/handlers.js).
//
// Power states are true (the speaker answers), false (nothing accepts the
// connection: standby, off or unreachable) or undefined (something answered,
// but not as expected): an unknown state is never published.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig } from './config.js';
import { DEFAULT_PORT, DEVICE_TYPE, FEATURES, LIMITS, TIMINGS } from './constants.js';
import { DevialetClient, isSafeId } from './devialet/client.js';
import { ERROR_KINDS, SpeakerError, request as defaultRequest } from './devialet/http.js';
import { INPUTS, currentSourceValue, sourceIdFor, sourceValues } from './devialet/inputs.js';
import { T } from './i18n.js';
import { buildDevice, deviceName, featureKey, sourceOptions, stateList } from './model.js';
import { FileStore, emptyData } from './store.js';

/** Timers fire a little early or late: a read due "now" is not skipped for 1 ms. */
const SLACK = 250;

const TRANSPORT = new Map([
  [FEATURES.PLAY, 'play'],
  [FEATURES.PAUSE, 'pause'],
  [FEATURES.NEXT, 'next'],
  [FEATURES.PREVIOUS, 'previous'],
]);

/** Answers that say "this endpoint has nothing for you now", not "the speaker is broken". */
const isSoftError = (err) => err?.kind === ERROR_KINDS.API || err?.kind === ERROR_KINDS.HTTP;

/** Answers that would come back the same if asked again soon: spaced out like no answer. */
const isSpacedError = (err) =>
  err?.kind === ERROR_KINDS.HTTP ||
  err?.kind === ERROR_KINDS.PROTOCOL ||
  err?.kind === ERROR_KINDS.API;

/**
 * The volume of a command, validated strictly: an integer 0..100 given as a
 * number or as a string of digits. null, '', true, 12.5, '12abc' are refused.
 * @returns {number | undefined}
 */
export function parseVolumeCommand(value) {
  let volume;
  if (typeof value === 'number') {
    volume = value;
  } else if (typeof value === 'string' && /^\s*\d{1,3}\s*$/.test(value)) {
    volume = Number(value);
  } else {
    return undefined;
  }
  return Number.isInteger(volume) && volume >= 0 && volume <= 100 ? volume : undefined;
}

/** Runs `task` over `items`, `limit` at a time, results in order. */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const short = (value) => String(value).slice(0, 32);

export class DevialetApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'devialet' }),
    store = new FileStore(),
    request = defaultRequest,
    now = Date.now,
    timers = globalThis,
    timings = TIMINGS,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.request = request;
    this.now = now;
    this.timers = timers;
    this.timings = timings;
    this.config = normalizeConfig();
    this.data = undefined;
    /** serial -> DevialetClient */
    this.clients = new Map();
    /** serial -> last reading { on, volume?, playback?, idle?, source? } */
    this.readings = new Map();
    /** serial -> { list, at }: the live source list (source ids change, values do not) */
    this.sourceLists = new Map();
    /** serial or "addr:<address>" -> { count, last, nextAt }: when to ask again */
    this.attempts = new Map();
    /** serial -> tail of the command queue */
    this.queues = new Map();
    /** serials of the devices created in Gladys */
    this.created = new Set();
    /** The last `getDevices` failed: asked again at every round until it works. */
    this.createdStale = false;
    /** The search in progress (one at a time), and when the last automatic one ran. */
    this.scanning = undefined;
    this.lastAutoScan = -Infinity;
    this.backgroundTimers = new Set();
    this.generation = 0;
    this.pollTimer = undefined;
    this.persistTimer = undefined;
    this.polling = undefined;
    this.lastStatus = undefined;
    this.warned = new Set();
    this.started = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * (Re)start with a configuration: on every connection to Gladys and on
   * every configuration save. On a (re)connection the core has forgotten the
   * states and the status: everything this app remembered as "already
   * published" is forgotten too.
   */
  async start(raw = {}, { connected = false } = {}) {
    this.config = normalizeConfig(raw);
    this.started = true;
    // The timer first: whatever fails below, the next round tries again.
    this.schedule();
    if (connected) {
      this.lastStatus = undefined;
      this.gladys.forgetPublishedStates?.();
    }
    if (!this.data) {
      try {
        this.data = await this.store.load();
      } catch {
        this.data = emptyData();
      }
      if (this.store.corrupted) {
        this.logger.warn('Unreadable /data/devialet.json moved to devialet.json.bad');
      }
    }
    await this.step('read the Gladys devices', () => this.refreshCreated());
    await this.step('probe the addresses', () => this.probeAddresses(true));
    await this.step('publish the devices', () => this.publishDevices());
    await this.step('publish the last states', () => this.republishReadings());
    await this.step('poll', () => this.poll(true));
    await this.step('publish the status', () => this.updateStatus());
  }

  async step(name, task) {
    try {
      await task();
    } catch (err) {
      this.logger.warn(`Start: could not ${name}: ${err.message}`);
    }
  }

  stop() {
    this.started = false;
    this.generation += 1;
    this.timers.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    for (const handle of this.backgroundTimers) {
      this.timers.clearTimeout(handle);
    }
    this.backgroundTimers.clear();
    if (this.persistTimer) {
      this.timers.clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      return this.store.save(this.data).catch(() => {});
    }
    return Promise.resolve();
  }

  schedule() {
    this.timers.clearInterval(this.pollTimer);
    this.pollTimer = this.timers.setInterval(() => this.tick(), this.config.pollInterval * 1000);
  }

  /** One timer round: the typed addresses not answering yet, the polling, the status. */
  tick() {
    if (!this.data) {
      return Promise.resolve();
    }
    return Promise.resolve()
      .then(() =>
        this.createdStale
          ? this.refreshCreated().catch((err) =>
              this.logger.warn(`Could not read the Gladys devices: ${err.message}`),
            )
          : undefined,
      )
      .then(() => this.autoScan())
      .then(() => this.probeAddresses(false))
      .then((changed) => (changed ? this.publishDevices() : undefined))
      .then(() => this.poll(false))
      .then(() => this.updateStatus())
      .catch((err) => this.logger.warn(`Polling failed: ${err.message}`));
  }

  /** Background work, cancelled by stop(). */
  later(task, ms) {
    const generation = this.generation;
    const handle = this.timers.setTimeout(() => {
      this.backgroundTimers.delete(handle);
      if (generation === this.generation) {
        Promise.resolve()
          .then(task)
          .catch((err) => this.logger.debug?.(`Background task failed: ${err.message}`));
      }
    }, ms);
    this.backgroundTimers.add(handle);
  }

  persist() {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = undefined;
      this.store
        .save(this.data)
        .catch((err) => this.logger.warn(`Could not save /data: ${err.message}`));
    }, this.timings.persistDelay);
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  enqueue(serial, task) {
    const previous = this.queues.get(serial) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.queues.set(
      serial,
      run.catch(() => {}),
    );
    return run;
  }

  // --- Spacing of the reads ----------------------------------------------------

  intervalMs() {
    return this.config.pollInterval * 1000;
  }

  /**
   * Whether `key` may be asked now. Never more often than the interval; after
   * failures, the interval doubled each time up to `maxBackoff`. `force` (a
   * start, a configuration save) only skips the backoff, not the interval.
   */
  isDue(key, force) {
    const record = this.attempts.get(key);
    if (!record) {
      return true;
    }
    if (this.now() - record.last < this.intervalMs() - SLACK) {
      return false;
    }
    return force || this.now() >= record.nextAt - SLACK;
  }

  /**
   * Records an attempt: `ok` true, false (no answer) or undefined (unexpected
   * answer). `backoff`: an unexpected answer that is spaced out too (HTTP
   * error, unreadable answer: asking again soon would get the same).
   */
  recordAttempt(key, ok, { backoff = false } = {}) {
    const record = this.attempts.get(key) ?? { count: 0 };
    record.last = this.now();
    if (ok === false || backoff) {
      record.count += 1;
      const backoff = Math.min(
        this.timings.maxBackoff,
        this.intervalMs() * 2 ** Math.min(record.count - 1, 16),
      );
      record.nextAt = record.last + backoff;
    } else {
      if (ok === true) {
        record.count = 0;
      }
      record.nextAt = record.last + this.intervalMs();
    }
    this.attempts.set(key, record);
    return record;
  }

  // --- Known speakers ----------------------------------------------------------

  get speakers() {
    return Object.values(this.data?.speakers ?? {});
  }

  client(speaker) {
    let client = this.clients.get(speaker.serial);
    if (!client || client.host !== speaker.host || client.port !== speaker.port) {
      client = new DevialetClient({
        host: speaker.host,
        port: speaker.port ?? DEFAULT_PORT,
        request: this.request,
        timeoutMs: this.timings.httpTimeout,
        now: this.now,
      });
      this.clients.set(speaker.serial, client);
    }
    return client;
  }

  speakerOfDevice(device) {
    return this.speakers.find(
      (s) => this.gladys.externalIds(DEVICE_TYPE, s.serial).device === device?.external_id,
    );
  }

  /**
   * The speakers created in Gladys. When `getDevices` fails, the list the SDK
   * keeps (`gladys.devices`) is used, and the call is made again at every
   * round until it works: a failed start never leaves the speakers unread.
   */
  async refreshCreated() {
    let devices;
    try {
      devices = await this.gladys.getDevices();
      this.createdStale = false;
    } catch (err) {
      this.createdStale = true;
      if (!Array.isArray(this.gladys.devices)) {
        throw err;
      }
      this.logger.warn(`Could not read the Gladys devices (${err.message}): using the last list`);
      devices = this.gladys.devices;
    }
    const bySerial = new Map(
      this.speakers.map((s) => [this.gladys.externalIds(DEVICE_TYPE, s.serial).device, s.serial]),
    );
    this.created = new Set(
      (Array.isArray(devices) ? devices : [])
        .map((d) => bySerial.get(d.external_id))
        .filter(Boolean),
    );
  }

  /**
   * The speakers shown in Gladys: one per Devialet system. A stereo pair
   * answers at two addresses with the same system: the speaker already
   * created in Gladys is kept, else the system leader, else the lowest serial.
   */
  publishedSpeakers() {
    const systems = new Map();
    for (const speaker of this.speakers) {
      const key = speaker.systemId || `serial:${speaker.serial}`;
      systems.set(key, [...(systems.get(key) ?? []), speaker]);
    }
    const result = [];
    for (const members of systems.values()) {
      const created = members.filter((s) => this.created.has(s.serial));
      if (created.length > 0) {
        result.push(...created);
        continue;
      }
      const sorted = [...members].sort((a, b) => a.serial.localeCompare(b.serial));
      result.push(sorted.find((s) => s.leader) ?? sorted[0]);
    }
    return result;
  }

  /**
   * Asks the speaker at `address` who it is and remembers it by serial
   * number. Throws a SpeakerError when nothing answers or it is not a
   * Devialet speaker.
   */
  async identify(address) {
    const probe = new DevialetClient({
      host: address.host,
      port: address.port,
      request: this.request,
      timeoutMs: this.timings.httpTimeout,
      now: this.now,
    });
    const description = await probe.describe();
    const systemName = await probe.systemName().catch(() => undefined);
    const speaker = this.remember({ ...description, systemName }, address);
    if (speaker) {
      // The "Source" dropdown is filled before the device is created.
      await this.sourceList(speaker, probe, { fresh: true, publish: false }).catch(() => {});
    }
    return speaker;
  }

  remember(description, address) {
    const speakers = this.data.speakers;
    if (!isSafeId(description.serial)) {
      return undefined;
    }
    let speaker = Object.hasOwn(speakers, description.serial)
      ? speakers[description.serial]
      : undefined;
    if (!speaker) {
      if (Object.keys(speakers).length >= LIMITS.speakers) {
        this.warnOnce(
          'speakers',
          `More than ${LIMITS.speakers} speakers: the next ones are ignored`,
        );
        return undefined;
      }
      speaker = { serial: description.serial, sourceValues: [] };
      speakers[description.serial] = speaker;
    }
    // Another speaker that had this address lost it (DHCP): it is found again
    // at its new address, never commanded at one that is no longer its own.
    for (const other of this.speakers) {
      if (
        other.serial !== speaker.serial &&
        other.host === address.host &&
        other.port === address.port
      ) {
        this.logger.warn(`${deviceName(other)} no longer answers at ${addressKey(address)}`);
        other.host = '';
        this.clients.delete(other.serial);
        this.readings.set(other.serial, { on: false });
      }
    }
    const before = JSON.stringify(speaker);
    Object.assign(speaker, {
      host: address.host,
      port: address.port,
      deviceId: description.deviceId,
      systemId: description.systemId,
      role: description.role,
      leader: description.leader,
      name: description.name,
      model: description.model,
      version: description.version,
    });
    if (description.systemName !== undefined) {
      speaker.systemName = description.systemName;
    }
    if (JSON.stringify(speaker) !== before) {
      this.persist();
    }
    return speaker;
  }

  /** The typed addresses that no known speaker answers at: asked again, spaced out. */
  async probeAddresses(force) {
    let changed = false;
    await Promise.all(
      this.config.addresses.map(async (address) => {
        const known = this.speakers.find((s) => s.host === address.host && s.port === address.port);
        if (known) {
          return;
        }
        const key = `addr:${addressKey(address)}`;
        if (!this.isDue(key, force)) {
          return;
        }
        try {
          const speaker = await this.identify(address);
          this.recordAttempt(key, true);
          changed = changed || Boolean(speaker);
        } catch (err) {
          this.recordAttempt(key, err.kind === ERROR_KINDS.UNREACHABLE ? false : undefined, {
            backoff: isSpacedError(err),
          });
          this.logger.debug?.(`${addressKey(address)}: ${err.message}`);
        }
      }),
    );
    return changed;
  }

  /** The typed addresses that still have no speaker. */
  silentAddresses() {
    return this.config.addresses
      .filter((a) => !this.speakers.some((s) => s.host === a.host && s.port === a.port))
      .filter((a) => this.attempts.has(`addr:${addressKey(a)}`))
      .map(addressKey);
  }

  /**
   * The optional mDNS search through Gladys, then the typed addresses. One
   * search at a time (a second request joins the running one); the answers
   * are asked `scanConcurrency` at a time, none started after `scanBudget`,
   * so the whole search ends within the 60 s of the "Find" button.
   */
  scan() {
    if (!this.scanning) {
      this.scanning = this.runScan().finally(() => {
        this.scanning = undefined;
      });
    }
    return this.scanning;
  }

  async runScan() {
    const deadline = this.now() + this.timings.scanBudget;
    let results = [];
    try {
      results = await this.gladys.scanNetwork('mdns', {
        timeoutSeconds: this.timings.scanSeconds,
      });
    } catch (err) {
      // Optional: the typed addresses work without it.
      this.logger.warn(`mDNS search failed: ${err.message}`);
    }
    const seen = new Set();
    const candidates = [];
    for (const result of (Array.isArray(results) ? results : []).slice(0, 50)) {
      const port =
        Number.isInteger(result?.port) && result.port > 0 && result.port < 65536
          ? result.port
          : DEFAULT_PORT;
      const hosts = (Array.isArray(result?.addresses) ? result.addresses : [])
        .filter((h) => typeof h === 'string' && isIP(h) === 4)
        .map((host) => ({ host, port }))
        .filter((a) => !seen.has(addressKey(a)))
        .slice(0, 4);
      hosts.forEach((a) => seen.add(addressKey(a)));
      if (hosts.length > 0) {
        candidates.push(hosts);
      }
    }
    await mapLimit(candidates, this.timings.scanConcurrency, async (hosts) => {
      for (const address of hosts) {
        if (this.now() >= deadline) {
          return;
        }
        try {
          await this.identify(address);
          return;
        } catch (err) {
          this.logger.debug?.(`${addressKey(address)} is not a Devialet speaker: ${err.message}`);
        }
      }
    });
    await this.probeAddresses(true);
    await this.publishDevices();
    return this.publishedSpeakers();
  }

  /** The created speakers whose address is unknown (lost to another speaker). */
  lostSpeakers() {
    return this.speakers.filter((s) => this.created.has(s.serial) && !s.host);
  }

  /** While a created speaker has no address: a search every `autoScanInterval`. */
  autoScan() {
    if (this.lostSpeakers().length === 0) {
      return;
    }
    if (this.now() - this.lastAutoScan < this.timings.autoScanInterval) {
      return;
    }
    this.lastAutoScan = this.now();
    // In the background: the polling of the other speakers does not wait for it.
    this.scan()
      .then(() => this.updateStatus())
      .catch((err) => this.logger.warn(`Automatic search failed: ${err.message}`));
  }

  /**
   * The source values of the device created in Gladys (`gladys.devices`, kept
   * up to date by the SDK), merged into the speaker: options seen before a
   * reset of /data are never dropped from the created device.
   */
  mergeCreatedOptions(speaker) {
    const externalId = this.gladys.externalIds(DEVICE_TYPE, speaker.serial).device;
    const device = (Array.isArray(this.gladys.devices) ? this.gladys.devices : []).find(
      (d) => d?.external_id === externalId,
    );
    const feature = (Array.isArray(device?.features) ? device.features : []).find(
      (f) => f?.external_id === `${externalId}:${FEATURES.SOURCE}`,
    );
    const options = Array.isArray(feature?.supported_options) ? feature.supported_options : [];
    const values = options
      .map((o) => o?.value)
      .filter((v) => typeof v === 'string' && Object.hasOwn(INPUTS, v));
    const merged = [...new Set([...(speaker.sourceValues ?? []), ...values])].sort();
    if (JSON.stringify(merged) !== JSON.stringify(speaker.sourceValues ?? [])) {
      speaker.sourceValues = merged;
      this.persist();
    }
  }

  async publishDevices() {
    if (!this.data) {
      return;
    }
    const speakers = this.publishedSpeakers();
    speakers.forEach((speaker) => this.mergeCreatedOptions(speaker));
    await this.gladys.publishDiscoveredDevices(
      speakers.map((speaker) => buildDevice(this.gladys, speaker)),
    );
  }

  // --- Polling -------------------------------------------------------------------

  poll(force = false) {
    if (!this.polling) {
      this.polling = Promise.all(
        this.speakers
          // A created speaker without an address is "read" too: its power is
          // published at 0 (no request is made).
          .filter((s) => this.created.has(s.serial) && this.isDue(s.serial, force))
          .map((s) => this.readState(s)),
      ).finally(() => {
        this.polling = undefined;
      });
    }
    return this.polling;
  }

  /** After a (re)connection: the last known states, for the speakers not read right away. */
  async republishReadings() {
    for (const speaker of this.speakers) {
      const reading = this.readings.get(speaker.serial);
      if (reading && this.created.has(speaker.serial)) {
        await this.publishStates(speaker, reading);
      }
    }
  }

  /** Calls `task`; an API or HTTP error of that one endpoint gives undefined. */
  async optional(task) {
    try {
      return await task();
    } catch (err) {
      if (isSoftError(err)) {
        return undefined;
      }
      throw err;
    }
  }

  /** The live source list of a speaker, read again after `sourcesRefresh`. */
  async sourceList(speaker, client, { fresh = false, publish = true } = {}) {
    const cached = this.sourceLists.get(speaker.serial);
    if (!fresh && cached && this.now() - cached.at < this.timings.sourcesRefresh) {
      return cached.list;
    }
    const list = await this.optional(() => client.sources());
    if (list === undefined) {
      return cached?.list ?? [];
    }
    this.sourceLists.set(speaker.serial, { list, at: this.now() });
    // The dropdown only grows: a source unplugged for a while keeps its option.
    const values = [...new Set([...(speaker.sourceValues ?? []), ...sourceValues(list, speaker)])]
      .filter((v) => Object.hasOwn(INPUTS, v))
      .sort();
    if (JSON.stringify(values) !== JSON.stringify(speaker.sourceValues ?? [])) {
      speaker.sourceValues = values;
      this.persist();
      if (publish) {
        await this.publishDevices().catch((err) =>
          this.logger.warn(`Could not publish the devices: ${err.message}`),
        );
      }
    }
    return list;
  }

  /**
   * One reading. `verify`: the speaker was not known to answer, so who
   * answers at its address is asked first (its address may now be another
   * speaker's).
   */
  async read(speaker, { verify = false, client = this.client(speaker) } = {}) {
    if (!speaker.host) {
      return { on: false };
    }
    try {
      // Who answers, and the system name, are read again with the source list
      // (every `sourcesRefresh`): a renamed system or a re-paired speaker shows.
      const cached = this.sourceLists.get(speaker.serial);
      const identityDue =
        verify || !cached || this.now() - cached.at >= this.timings.sourcesRefresh;
      if (identityDue) {
        const description = await client.describe();
        if (description.serial !== speaker.serial) {
          this.logger.warn(
            `${deviceName(speaker)}: another speaker answers at ${speaker.host}, run a search`,
          );
          const address = { host: speaker.host, port: speaker.port };
          speaker.host = '';
          this.clients.delete(speaker.serial);
          this.persist();
          this.remember({ ...description }, address);
          return { on: false };
        }
        const systemName = await this.optional(() => client.systemName());
        const before = deviceName(speaker);
        this.remember(
          { ...description, systemName: systemName ?? speaker.systemName },
          { host: speaker.host, port: speaker.port },
        );
        if (deviceName(speaker) !== before) {
          await this.publishDevices().catch((err) =>
            this.logger.warn(`Could not publish the devices: ${err.message}`),
          );
        }
      }
      const playback = await this.optional(() => client.playback());
      const sources = await this.sourceList(speaker, client);
      const volume = await this.optional(() => client.volume());
      return {
        on: true,
        volume,
        playback,
        idle: playback === undefined,
        source: playback ? currentSourceValue(playback, sources, speaker) : undefined,
      };
    } catch (err) {
      if (err.kind === ERROR_KINDS.UNREACHABLE) {
        return { on: false };
      }
      this.warnOnce(`read:${speaker.serial}`, `${deviceName(speaker)}: ${err.message}`);
      return { on: undefined, spaced: isSpacedError(err) };
    }
  }

  async readState(speaker) {
    const wasOn = this.readings.get(speaker.serial)?.on;
    const reading = await this.read(speaker, { verify: wasOn !== true });
    const record = this.recordAttempt(speaker.serial, reading.on, {
      backoff: reading.spaced === true,
    });
    if (reading.on === false && record.count === 1) {
      this.logger.info(`${deviceName(speaker)} does not answer (standby, off or unreachable)`);
    }
    if (reading.on === true && wasOn === false) {
      this.logger.info(`${deviceName(speaker)} answers again`);
    }
    if (reading.on !== undefined) {
      this.readings.set(speaker.serial, reading);
    }
    await this.publishStates(speaker, reading);
    return reading;
  }

  async publishStates(speaker, reading) {
    const states = stateList(this.gladys, speaker, reading);
    if (!this.created.has(speaker.serial) || states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states);
    } catch (err) {
      this.logger.warn(`Could not publish the states of ${deviceName(speaker)}: ${err.message}`);
    }
  }

  /** Merges a partial reading into the last one and publishes it (after a command). */
  async publishPartial(speaker, partial) {
    const reading = { ...(this.readings.get(speaker.serial) ?? {}), on: true, ...partial };
    this.readings.set(speaker.serial, reading);
    await this.publishStates(speaker, { on: true, ...partial });
  }

  recheck(speaker) {
    this.later(() => this.readState(speaker), this.timings.recheckDelay);
  }

  // --- Commands --------------------------------------------------------------------

  /** Validates a command before anything is queued or sent. */
  validate(speaker, key, value) {
    if (key === FEATURES.VOLUME) {
      const volume = parseVolumeCommand(value);
      if (volume === undefined) {
        throw new Error(`Invalid volume "${short(value)}": an integer from 0 to 100`);
      }
      return volume;
    }
    if (key === FEATURES.SOURCE) {
      if (typeof value !== 'string' || !sourceOptions(speaker).some((o) => o.value === value)) {
        throw new Error(`Unknown source "${short(value)}"`);
      }
      return value;
    }
    if (key === FEATURES.MUTE || key === FEATURES.STANDBY || TRANSPORT.has(key)) {
      return undefined;
    }
    throw new Error(`Feature "${short(key)}" cannot be commanded`);
  }

  async setValue(device, feature, value) {
    const speaker = this.speakerOfDevice(device);
    if (!speaker) {
      throw new Error(`Unknown speaker ${short(device?.external_id)}`);
    }
    const key = featureKey(device.external_id, feature?.external_id);
    const checked = this.validate(speaker, key, value);
    // The budget runs from the request of Gladys, the wait in the queue included.
    const started = this.now();
    let late = false;
    // Set just before a command request leaves: from then on, the command may
    // have reached the speaker, whatever happens next.
    const context = { mayHaveSent: false };
    const run = this.enqueue(speaker.serial, async () => {
      if (late || this.remaining(started) < 50) {
        // Gladys stopped waiting while this command was queued: dropped, never sent late.
        late = true;
        throw new SpeakerError(ERROR_KINDS.BUDGET, 'No time left for this command, nothing sent');
      }
      return this.command(speaker, key, checked, started, context);
    });
    // Wall-clock deadline (not the injectable timers): the ack Gladys waits for.
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => {
          late = true;
          if (context.mayHaveSent) {
            this.recheck(speaker);
            reject(
              new SpeakerError(ERROR_KINDS.TIMEOUT, 'Sent, without confirmation from the speaker', {
                sent: true,
              }),
            );
            return;
          }
          reject(
            new SpeakerError(
              ERROR_KINDS.BUDGET,
              'No time left for this command (speaker busy), nothing sent',
            ),
          );
        },
        Math.max(0, this.remaining(started)) + 100,
      );
    });
    run.catch(() => {});
    try {
      return await Promise.race([run, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  remaining(started) {
    return this.timings.commandBudget - (this.now() - started);
  }

  /**
   * Sends one command request. A request that may have reached the speaker
   * (connected, then silent) is never reported as "not sent": "sent, without
   * confirmation", and the state is read again shortly after.
   */
  async send(speaker, task, context) {
    if (context) {
      context.mayHaveSent = true;
    }
    try {
      return await task();
    } catch (err) {
      if (err.kind === ERROR_KINDS.TIMEOUT) {
        this.recheck(speaker);
        throw new SpeakerError(ERROR_KINDS.TIMEOUT, 'Sent, without confirmation from the speaker', {
          sent: true,
        });
      }
      if (err.kind === ERROR_KINDS.UNREACHABLE || err.kind === ERROR_KINDS.BUDGET) {
        // The connection was never accepted (or never opened): nothing left.
        if (context) {
          context.mayHaveSent = false;
        }
        throw new SpeakerError(
          err.kind,
          err.kind === ERROR_KINDS.BUDGET
            ? 'No time left for this command, nothing sent'
            : `${deviceName(speaker)} does not answer (standby, off or unreachable): nothing sent`,
        );
      }
      throw err;
    }
  }

  /**
   * A read made before a command request (mute state, source ids): whatever
   * goes wrong, nothing was sent, and no recheck is needed.
   */
  async readBefore(speaker, what, task) {
    try {
      return await task();
    } catch (err) {
      if (err.kind === ERROR_KINDS.UNREACHABLE) {
        throw new SpeakerError(
          ERROR_KINDS.UNREACHABLE,
          `${deviceName(speaker)} does not answer (standby, off or unreachable): nothing sent`,
        );
      }
      if (err.kind === ERROR_KINDS.TIMEOUT || err.kind === ERROR_KINDS.BUDGET) {
        throw new SpeakerError(err.kind, `${what} not read in time: nothing sent`);
      }
      throw err;
    }
  }

  /**
   * Runs one command. The states it implies are published in the background
   * (never awaited here): a slow Gladys never turns a command the speaker
   * accepted into a failed ack.
   */
  async command(speaker, key, value, started, context = { mayHaveSent: false }) {
    if (!speaker.host) {
      throw new SpeakerError(
        ERROR_KINDS.UNREACHABLE,
        `${deviceName(speaker)}: address unknown, run "Find the speakers"`,
      );
    }
    const client = () => this.client(speaker).withBudget(this.remaining(started));
    const publish = (partial) => {
      this.publishPartial(speaker, partial).catch(() => {});
    };
    if (key === FEATURES.VOLUME) {
      await this.send(speaker, () => client().setVolume(value), context);
      publish({ volume: value });
      return undefined;
    }
    if (key === FEATURES.MUTE) {
      // Gladys sends a press, not a target: the mute is read from the speaker
      // just before, and the opposite is set (two explicit endpoints, no toggle).
      const budget = Math.min(this.timings.preRead, this.remaining(started));
      const playback = await this.readBefore(speaker, 'Mute state', () =>
        this.client(speaker).withBudget(budget).playback(),
      );
      if (typeof playback.muted !== 'boolean') {
        throw new Error(`${deviceName(speaker)}: mute state unknown, nothing sent`);
      }
      const muted = !playback.muted;
      await this.send(speaker, () => client().setMute(muted), context);
      publish({ playback: { ...playback, muted } });
      return undefined;
    }
    if (TRANSPORT.has(key)) {
      await this.send(speaker, () => client()[TRANSPORT.get(key)](), context);
      this.recheck(speaker);
      return undefined;
    }
    if (key === FEATURES.STANDBY) {
      try {
        await this.send(speaker, () => client().powerOff(), context);
      } catch (err) {
        if (err.kind !== ERROR_KINDS.UNREACHABLE) {
          throw err;
        }
        // Nothing answers: already in standby (or off the network). Nothing
        // was sent, and nothing else is wanted from a standby button.
        this.logger.info(`${deviceName(speaker)} does not answer: already in standby or off`);
      }
      this.recheck(speaker);
      return undefined;
    }
    if (key === FEATURES.SOURCE) {
      // Source ids are read again: they belong to the speaker, not to Gladys.
      const list = await this.readBefore(speaker, 'Source list', () => client().sources());
      this.sourceLists.set(speaker.serial, { list, at: this.now() });
      const sourceId = sourceIdFor(value, list, speaker);
      if (!sourceId) {
        throw new Error(
          `${deviceName(speaker)}: source "${value}" not available now, nothing sent`,
        );
      }
      await this.send(speaker, () => client().playSource(sourceId), context);
      publish({ source: value });
      this.recheck(speaker);
      return undefined;
    }
    throw new Error(`Feature "${short(key)}" cannot be commanded`);
  }

  // --- Device lifecycle --------------------------------------------------------------

  async deviceCreated(device) {
    const speaker = this.speakerOfDevice(device);
    if (!speaker) {
      return;
    }
    this.created.add(speaker.serial);
    this.readings.delete(speaker.serial);
    await this.readState(speaker);
    await this.updateStatus();
  }

  async deviceDeleted(device) {
    const speaker = this.speakerOfDevice(device);
    if (speaker) {
      this.created.delete(speaker.serial);
      this.readings.delete(speaker.serial);
      await this.updateStatus();
    }
  }

  // --- Configuration screen buttons -------------------------------------------------

  async findSpeakers() {
    const speakers = await this.scan();
    await this.updateStatus();
    return T.found(speakers.map((s) => `${deviceName(s)} (${s.host || '?'})`));
  }

  async checkSpeakers() {
    const speakers = this.publishedSpeakers();
    if (speakers.length === 0) {
      return T.noSpeaker;
    }
    const lines = await mapLimit(speakers, this.timings.checkConcurrency, async (speaker) =>
      T.checkLine(`${deviceName(speaker)} (${speaker.host || '?'})`, await this.read(speaker)),
    );
    return T.check(lines);
  }

  // --- Status ---------------------------------------------------------------------

  async updateStatus() {
    if (!this.started) {
      return;
    }
    const notes = [];
    if (this.store.corrupted) {
      notes.push(T.dataReset);
    }
    if (this.config.invalid.length > 0) {
      notes.push(T.invalidEntries(this.config.invalid));
    }
    const silent = this.silentAddresses();
    if (silent.length > 0) {
      notes.push(T.noAnswerAt(silent));
    }
    const lost = this.lostSpeakers();
    if (lost.length > 0) {
      notes.push(T.addressUnknown(lost.map(deviceName)));
    }
    const off = this.speakers
      .filter(
        (s) => this.created.has(s.serial) && s.host && this.readings.get(s.serial)?.on === false,
      )
      .map(deviceName);
    if (off.length > 0) {
      notes.push(T.unreachable(off));
    }
    // A local integration without an account: "connected" means running; what
    // does not answer is said in the message.
    const status = { connected: true };
    if (notes.length > 0) {
      status.message = {
        en: notes.map((n) => n.en).join(' '),
        fr: notes.map((n) => n.fr).join(' '),
      };
    }
    const key = JSON.stringify(status);
    if (key === this.lastStatus) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`Could not publish the status: ${err.message}`);
    }
  }
}
