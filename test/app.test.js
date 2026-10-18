// -----------------------------------------------------------------------------
// DevialetApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), a memory store and the fake speaker on the loopback
// interface. The polling timer never fires: the tests drive it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DevialetApp, parseVolumeCommand } from '../src/app.js';
import { NOTHING, TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { MemoryStore } from '../src/store.js';
import { request as httpRequest } from '../src/devialet/http.js';
import { SERIAL, startFakeSpeaker } from './fixtures/fakeSpeaker.js';

const SELECTOR = 'devialet';
const id = (key, serial = SERIAL) => `ext:${SELECTOR}:speaker:${serial}${key ? `:${key}` : ''}`;

/** No polling interval; short real timeouts for the background work. */
const timers = {
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, Math.min(ms, 5)),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

async function setup(
  t,
  { speakerOptions, config, scanResults = {}, timings = {}, clock, request } = {},
) {
  const speaker = await startFakeSpeaker(speakerOptions);
  t.after(() => speaker.close());
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: config ?? { addresses: `127.0.0.1:${speaker.port}` },
    scanResults,
  });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  const store = new MemoryStore();
  const app = new DevialetApp({
    gladys,
    logger,
    store,
    timers,
    ...(request ? { request } : {}),
    now: clock ? () => clock.now : Date.now,
    timings: { ...TIMINGS, httpTimeout: 500, recheckDelay: 1, ...timings },
  });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  t.after(() => app.stop());
  return { speaker, gladys, app, logs, store };
}

async function createSpeaker(gladys, serial = SERIAL) {
  const device = gladys.fake.discoveredDevices.find((d) => d.external_id === id(undefined, serial));
  assert.ok(device, 'the speaker is in the Discovery tab');
  await gladys.fake.deviceCreated(device);
  return device;
}

const set = (gladys, device, key, value) =>
  gladys.fake.setValue(
    device,
    device.features.find((f) => f.external_id === id(key)),
    value,
  );

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test('a typed address becomes a Gladys device; its states once created', async (t) => {
  const { gladys } = await setup(t);
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.external_id, id());
  assert.equal(device.name, 'Living room (Phantom I)');
  const keys = device.features.map((f) => f.external_id.slice(id().length + 1));
  assert.deepEqual(keys, [
    'power',
    'standby',
    'volume',
    'mute',
    'play',
    'pause',
    'next',
    'previous',
    'playback',
    'source',
    'title',
  ]);
  assert.ok(device.features.every((f) => f.min !== undefined && f.max !== undefined));
  const byKey = Object.fromEntries(device.features.map((f) => [f.external_id.split(':').pop(), f]));
  // No switch, nothing an "everything off" could command; the power is read only.
  assert.ok(device.features.every((f) => f.category !== 'switch'));
  assert.equal(byKey.power.read_only, true);
  assert.equal(byKey.power.category, 'unknown');
  assert.deepEqual([byKey.standby.category, byKey.standby.type], ['button', 'push']);
  assert.deepEqual([byKey.volume.category, byKey.volume.type], ['music', 'volume']);
  assert.equal(byKey.volume.unit, undefined, 'no unit for the music category');
  assert.deepEqual(
    byKey.source.supported_options.map((o) => o.value),
    ['airplay2', 'optical_left', 'optical_right', 'spotifyconnect'],
    'the known sources of the speaker, the optical inputs of a stereo pair by side',
  );
  assert.equal(gladys.fake.states.length, 0, 'no state before the device is created');

  await createSpeaker(gladys);
  assert.equal(gladys.fake.lastState(id('power')), 1);
  assert.equal(gladys.fake.lastState(id('volume')), 30);
  assert.equal(gladys.fake.lastState(id('mute')), 0);
  assert.equal(gladys.fake.lastState(id('playback')), 1);
  assert.equal(gladys.fake.lastState(id('title')), 'Daft Punk - Get Lucky');
  assert.equal(gladys.fake.lastState(id('source')), 'spotifyconnect');
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('volume: set, and validated strictly before anything is sent', async (t) => {
  const { speaker, gladys } = await setup(t);
  const device = await createSpeaker(gladys);
  assert.equal((await set(gladys, device, 'volume', 42)).success, true);
  assert.equal(speaker.state.volume, 42);
  assert.equal(gladys.fake.lastState(id('volume')), 42);
  const before = speaker.posts().length;
  for (const bad of [null, '', ' ', -1, 101, 12.5, '12abc', true, NaN, Infinity, '1e2', {}]) {
    assert.equal((await set(gladys, device, 'volume', bad)).success, false, String(bad));
  }
  assert.equal(speaker.posts().length, before, 'no invalid volume reached the speaker');
  assert.equal((await set(gladys, device, 'volume', '0')).success, true);
  assert.equal(speaker.state.volume, 0);
});

test('parseVolumeCommand accepts integers 0..100 only', () => {
  assert.equal(parseVolumeCommand(0), 0);
  assert.equal(parseVolumeCommand(100), 100);
  assert.equal(parseVolumeCommand(' 7 '), 7);
  for (const bad of [null, undefined, '', -0.5, 100.1, '0x10', [], false]) {
    assert.equal(parseVolumeCommand(bad), undefined, String(bad));
  }
});

test('mute: each press sets the opposite of the state read from the speaker', async (t) => {
  const { speaker, gladys } = await setup(t);
  const device = await createSpeaker(gladys);
  await set(gladys, device, 'mute', 1);
  assert.equal(speaker.state.muted, true);
  assert.equal(gladys.fake.lastState(id('mute')), 1);
  // Muted from the Devialet app meanwhile: the press reads it first.
  speaker.state.muted = false;
  await set(gladys, device, 'mute', 1);
  assert.equal(speaker.state.muted, true);
  const paths = speaker.posts().map((r) => r.path.split('/').pop());
  assert.deepEqual(paths, ['mute', 'mute'], 'explicit mute/unmute endpoints, never a toggle');
});

test('mute state unknown: nothing sent', async (t) => {
  const { speaker, gladys } = await setup(t);
  const device = await createSpeaker(gladys);
  speaker.state.idle = true;
  const ack = await set(gladys, device, 'mute', 1);
  assert.equal(ack.success, false);
  assert.equal(speaker.posts().length, 0);
});

test('play, pause, next, previous and standby', async (t) => {
  const { speaker, gladys } = await setup(t);
  const device = await createSpeaker(gladys);
  for (const key of ['pause', 'play', 'next', 'previous', 'standby']) {
    assert.equal((await set(gladys, device, key, 1)).success, true, key);
  }
  assert.deepEqual(
    speaker.posts().map((r) => r.path.split('/').slice(-2).join('/')),
    ['playback/pause', 'playback/play', 'playback/next', 'playback/previous', 'current/powerOff'],
  );
  assert.equal(speaker.state.poweredOff, true);
  await settle();
  assert.equal(gladys.fake.lastState(id('playback')), 1, 'read again after the commands');
});

test('source: validated against the dropdown, played by its live source id', async (t) => {
  const { speaker, gladys } = await setup(t);
  const device = await createSpeaker(gladys);
  assert.equal((await set(gladys, device, 'source', 'optical_right')).success, true);
  assert.equal(speaker.state.current, 'src-optical-r', 'the partner speaker optical input');
  assert.equal(gladys.fake.lastState(id('source')), 'optical_right');
  assert.equal((await set(gladys, device, 'source', 'airplay2')).success, true);
  assert.equal(speaker.state.current, 'src-airplay');
  const before = speaker.posts().length;
  for (const bad of ['phono', 'not_a_known_type', '../../powerOff', 3, null]) {
    assert.equal((await set(gladys, device, 'source', bad)).success, false, String(bad));
  }
  assert.equal(speaker.posts().length, before);
});

test('a speaker in standby or unreachable is marked so, then asked again at spaced intervals', async (t) => {
  const clock = { now: 1_000_000 };
  const { speaker, gladys, app } = await setup(t, { clock });
  const device = await createSpeaker(gladys);
  assert.equal(gladys.fake.lastState(id('power')), 1);
  await speaker.close();

  clock.now += 10_000;
  await app.tick();
  assert.equal(gladys.fake.lastState(id('power')), 0);
  assert.match(gladys.fake.connectionStatus.message.en, /Not answering.*Living room/);
  assert.match(gladys.fake.connectionStatus.message.fr, /Ne répondent pas/);
  assert.equal(gladys.fake.connectionStatus.connected, true);

  // Asked again after 10 s, then 20 s, 40 s...: never in a loop.
  const reads = () => app.attempts.get(SERIAL).count;
  clock.now += 10_000;
  await app.tick();
  assert.equal(reads(), 2);
  clock.now += 10_000;
  await app.tick();
  assert.equal(reads(), 2, 'not due before 20 s');
  clock.now += 10_000;
  await app.tick();
  assert.equal(reads(), 3);
  for (let i = 0; i < 40; i += 1) {
    clock.now += 10_000;
    await app.tick();
  }
  const record = app.attempts.get(SERIAL);
  assert.ok(record.nextAt - record.last <= TIMINGS.maxBackoff, 'the backoff is capped');

  // A command to a speaker that does not answer says so; standby needs nothing.
  const volume = await set(gladys, device, 'volume', 10);
  assert.equal(volume.success, false);
  assert.equal((await set(gladys, device, 'standby', 1)).success, true);
});

test('a speaker that answers again is read at the normal interval', async (t) => {
  const clock = { now: 1_000_000 };
  const { speaker, gladys, app } = await setup(t, { clock });
  await createSpeaker(gladys);
  speaker.state.silent = true;
  clock.now += 10_000;
  await app.tick();
  // Connected, then silent: not proof of standby, nothing published.
  assert.equal(gladys.fake.lastState(id('power')), 1);
  speaker.state.silent = false;
  speaker.state.volume = 55;
  clock.now += 10_000;
  await app.tick();
  assert.equal(gladys.fake.lastState(id('volume')), 55);
});

test('a hostile answer is cut, never published', async (t) => {
  const { speaker, gladys, app } = await setup(t);
  await createSpeaker(gladys);
  const count = gladys.fake.states.length;
  speaker.state.hostile = true;
  await app.readState(app.speakers[0]);
  assert.equal(gladys.fake.states.length, count, 'nothing published from a 200 KB answer');
});

test('nothing playing: the title says so', async (t) => {
  const { speaker, gladys } = await setup(t, { speakerOptions: { idle: true } });
  await createSpeaker(gladys);
  assert.equal(gladys.fake.lastState(id('power')), 1);
  assert.equal(gladys.fake.lastState(id('title')), NOTHING);
  assert.equal(speaker.state.idle, true);
});

test('a typed address that does not answer is reported, then found', async (t) => {
  const clock = { now: 1_000_000 };
  const { speaker, gladys, app } = await setup(t, {
    clock,
    config: { addresses: '127.0.0.1:1, bad_host!' },
  });
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  assert.match(gladys.fake.connectionStatus.message.en, /127\.0\.0\.1:1/);
  assert.match(gladys.fake.connectionStatus.message.en, /Ignored.*bad_host!/);
  await gladys.fake.configUpdated({ addresses: `127.0.0.1:${speaker.port}` });
  assert.equal(app.speakers.length, 1);
  assert.equal(gladys.fake.discoveredDevices.at(-1).external_id, id());
});

test('mDNS search through Gladys (optional), and its failure never blocks', async (t) => {
  const speaker = await startFakeSpeaker();
  t.after(() => speaker.close());
  const { gladys, app } = await setup(t, {
    config: { addresses: '' },
    scanResults: {
      mdns: [
        { name: 'junk', host: null, addresses: ['::1', 'zzz'], port: null, txt: [] },
        {
          name: 'Phantom._devialet-http._tcp.local',
          host: 'phantom.local',
          addresses: ['127.0.0.1'],
          port: speaker.port,
          txt: ['serialNumber=R0123456789'],
        },
      ],
    },
  });
  const ack = await gladys.fake.action('find_speakers');
  assert.equal(ack.success, true);
  assert.match(ack.data.message.en, /Living room/);
  assert.equal(app.speakers.length, 1);

  app.gladys.scanNetwork = async () => {
    throw new Error('403');
  };
  const again = await gladys.fake.action('find_speakers');
  assert.equal(again.success, true);
});

test('a stereo pair typed twice is one Gladys device (the leader)', async (t) => {
  const left = await startFakeSpeaker();
  const right = await startFakeSpeaker({
    serial: 'R0000000002',
    deviceId: 'aaaaaaaa-1111-4111-8111-000000000002',
    role: 'FrontRight',
    leader: false,
    name: 'Phantom Right',
  });
  t.after(() => Promise.all([left.close(), right.close()]));
  const { gladys } = await setup(t, {
    config: { addresses: `127.0.0.1:${right.port}, 127.0.0.1:${left.port}` },
  });
  const devices = gladys.fake.discoveredDevices;
  assert.equal(devices.length, 1);
  assert.equal(devices[0].external_id, id());
});

test('another speaker at the address (DHCP): never commanded there', async (t) => {
  const clock = { now: 1_000_000 };
  const { speaker, gladys, app } = await setup(t, { clock });
  await createSpeaker(gladys);
  await speaker.close();
  clock.now += 10_000;
  await app.tick();
  // A different speaker now answers at that address.
  const other = await startFakeSpeaker({ serial: 'R9999999999', systemId: 'other-system' });
  t.after(() => other.close());
  app.speakers[0].port = other.port;
  clock.now += 30_000;
  await app.tick();
  const first = app.data.speakers[SERIAL];
  assert.equal(first.host, '', 'the address is cleared');
  assert.ok(app.data.speakers.R9999999999, 'the other speaker is remembered');
});

test('a reconnection to Gladys publishes the states again', async (t) => {
  const { gladys, app } = await setup(t);
  await createSpeaker(gladys);
  const count = gladys.fake.states.length;
  await app.start(
    { addresses: app.config.addresses.map((a) => `${a.host}:${a.port}`).join(',') },
    {
      connected: true,
    },
  );
  assert.ok(gladys.fake.states.length > count, 'states published again');
});

test('check the speakers', async (t) => {
  const { gladys } = await setup(t);
  const ack = await gladys.fake.action('check_speakers');
  assert.match(ack.data.message.en, /answers, volume 30/);
  assert.match(ack.data.message.fr, /répond, volume 30/);
});

for (const trap of ['__proto__', 'constructor', 'prototype']) {
  test(`a speaker answering the serial "${trap}" is ignored`, async (t) => {
    const { gladys, app } = await setup(t, { speakerOptions: { serial: trap } });
    assert.equal(gladys.fake.discoveredDevices.at(-1)?.features?.length ?? 0, 0);
    assert.equal(app.speakers.length, 0);
    assert.equal(Object.getPrototypeOf(app.data.speakers), null);
    assert.equal({}.serial, undefined, 'Object.prototype untouched');
    assert.equal(typeof {}.constructor, 'function');
  });
}

test('a slow Gladys never turns an accepted command into a failed ack', async (t) => {
  const { speaker, gladys, app } = await setup(t, { timings: { commandBudget: 400 } });
  const device = await createSpeaker(gladys);
  // Publishing the states never ends.
  app.gladys.publishChangedStates = () => new Promise(() => {});
  for (const [key, value] of [
    ['volume', 21],
    ['mute', 1],
    ['source', 'airplay2'],
  ]) {
    const ack = await set(gladys, device, key, value);
    assert.equal(ack.success, true, key);
  }
  assert.equal(speaker.state.volume, 21);
  assert.equal(speaker.state.muted, true);
  assert.equal(speaker.state.current, 'src-airplay');
});

test('deadline: "sent, without confirmation" once a request left, "nothing sent" before', async (t) => {
  let hangPosts = false;
  const request = (options) =>
    hangPosts && options.method === 'POST' ? new Promise(() => {}) : httpRequest(options);
  const { speaker, gladys } = await setup(t, { request, timings: { commandBudget: 300 } });
  const device = await createSpeaker(gladys);
  hangPosts = true;
  const sent = await set(gladys, device, 'volume', 40);
  assert.equal(sent.success, false);
  assert.match(JSON.stringify(sent), /Sent, without confirmation/);

  // The pre-read of the mute hangs: nothing was sent.
  hangPosts = false;
  speaker.state.silent = true;
  const before = speaker.posts().length;
  const muted = await set(gladys, device, 'mute', 1);
  assert.equal(muted.success, false);
  assert.match(JSON.stringify(muted), /nothing sent/);
  assert.equal(speaker.posts().length, before);
});

test('getDevices failing at start: the speakers are still read', async (t) => {
  const clock = { now: 1_000_000 };
  const { speaker, gladys, app } = await setup(t, { clock });
  await createSpeaker(gladys);
  const original = app.gladys.getDevices.bind(app.gladys);
  app.gladys.getDevices = async () => {
    throw new Error('503');
  };

  // With the SDK's own list: the created speakers are known at once.
  app.created.clear();
  clock.now += 10_000;
  await app.start({ addresses: `127.0.0.1:${speaker.port}` }, { connected: true });
  assert.equal(app.created.has(SERIAL), true);
  assert.equal(app.createdStale, true);

  // Without it: read again at every round until it works.
  const sdkDevices = app.gladys.devices;
  app.gladys.devices = undefined;
  app.created.clear();
  clock.now += 10_000;
  await app.start({ addresses: `127.0.0.1:${speaker.port}` }, { connected: true });
  assert.equal(app.created.size, 0);
  app.gladys.getDevices = original;
  app.gladys.devices = sdkDevices;
  speaker.state.volume = 66;
  clock.now += 10_000;
  await app.tick();
  assert.equal(app.created.has(SERIAL), true);
  assert.equal(app.createdStale, false);
  assert.equal(gladys.fake.lastState(id('volume')), 66);
});

test('a created speaker that lost its address: power 0, status, automatic search', async (t) => {
  const clock = { now: 1_000_000 };
  const { gladys, app } = await setup(t, { clock, config: { addresses: '' } });
  const other = await startFakeSpeaker();
  t.after(() => other.close());
  // Found by the search, created.
  app.gladys.scanNetwork = async () => [
    { name: 'x', host: null, addresses: ['127.0.0.1'], port: other.port, txt: [] },
  ];
  await gladys.fake.action('find_speakers');
  await createSpeaker(gladys);
  // Its address is lost (another speaker answered there).
  app.data.speakers[SERIAL].host = '';
  let searches = 0;
  app.gladys.scanNetwork = async () => {
    searches += 1;
    return [];
  };
  clock.now += 10_000;
  await app.tick();
  await settle();
  assert.equal(gladys.fake.lastState(id('power')), 0);
  assert.match(gladys.fake.connectionStatus.message.en, /Address unknown.*Find the speakers/);
  assert.match(gladys.fake.connectionStatus.message.fr, /Adresse inconnue.*Chercher les enceintes/);
  assert.equal(searches, 1);
  clock.now += 60_000;
  await app.tick();
  await settle();
  assert.equal(searches, 1, 'not again before 10 minutes');
  clock.now += 10 * 60_000;
  await app.tick();
  await settle();
  assert.equal(searches, 2);
  // Found again at its address by a search: read normally.
  app.gladys.scanNetwork = async () => [
    { name: 'x', host: null, addresses: ['127.0.0.1'], port: other.port, txt: [] },
  ];
  await gladys.fake.action('find_speakers');
  assert.equal(app.data.speakers[SERIAL].host, '127.0.0.1');
  clock.now += 60_000;
  await app.tick();
  assert.equal(gladys.fake.lastState(id('power')), 1);
});

test('the Source options of the created device are never dropped', async (t) => {
  const { gladys, app } = await setup(t);
  const device = await createSpeaker(gladys);
  const withPhono = {
    ...device,
    features: device.features.map((f) =>
      f.external_id === id('source')
        ? { ...f, supported_options: [...f.supported_options, { value: 'phono', label: 'Phono' }] }
        : f,
    ),
  };
  await gladys.fake.deviceUpdated(withPhono);
  app.data.speakers[SERIAL].sourceValues = ['airplay2'];
  await app.publishDevices();
  const published = gladys.fake.discoveredDevices.at(-1);
  const values = published.features
    .find((f) => f.external_id === id('source'))
    .supported_options.map((o) => o.value);
  assert.ok(values.includes('phono'));
  assert.ok(values.includes('spotifyconnect'));
});

test('one search at a time', async (t) => {
  const { app } = await setup(t, { config: { addresses: '' } });
  let calls = 0;
  app.gladys.scanNetwork = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return [];
  };
  await Promise.all([app.scan(), app.scan(), app.scan()]);
  assert.equal(calls, 1);
});
