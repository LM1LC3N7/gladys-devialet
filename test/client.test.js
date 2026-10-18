// -----------------------------------------------------------------------------
// The client and the parsing of the answers (pure parts, and node:http against
// the fake speaker): untrusted fields, bounded sizes, error kinds.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import {
  DevialetClient,
  PATHS,
  cleanText,
  parseDevice,
  parsePlayback,
  parseVolume,
} from '../src/devialet/client.js';
import { ERROR_KINDS, MAX_BODY, request } from '../src/devialet/http.js';
import {
  currentSourceValue,
  parseSources,
  sourceIdFor,
  sourceValues,
} from '../src/devialet/inputs.js';
import { DEVICE_ID, PARTNER_ID, SERIAL, startFakeSpeaker } from './fixtures/fakeSpeaker.js';

test('parseDevice keeps the expected fields only', () => {
  const device = parseDevice({
    serial: SERIAL,
    deviceId: DEVICE_ID,
    deviceName: 'Kitchen\u0000‮  speaker',
    isSystemLeader: 'yes',
    role: 'FrontLeft',
    model: 'x'.repeat(500),
  });
  assert.equal(device.serial, SERIAL);
  assert.equal(device.name, 'Kitchen speaker');
  assert.equal(device.leader, false, 'only a true boolean');
  assert.equal(device.model.length, 64);
  assert.throws(() => parseDevice({ serial: '../etc' }), { kind: ERROR_KINDS.PROTOCOL });
  assert.throws(() => parseDevice(null), { kind: ERROR_KINDS.PROTOCOL });
});

test('parsePlayback and parseVolume never guess', () => {
  assert.deepEqual(parsePlayback({}).playing, undefined);
  assert.equal(parsePlayback({ playingState: 'playing', muteState: 'muted' }).muted, true);
  assert.equal(parsePlayback({ playingState: 'stopped' }).playing, undefined);
  assert.equal(parsePlayback({ metadata: { title: 42 } }).title, undefined);
  assert.equal(parseVolume({ volume: 33.4 }), 33);
  for (const bad of [{ volume: '30' }, { volume: -1 }, { volume: 101 }, { volume: null }, null]) {
    assert.equal(parseVolume(bad), undefined);
  }
  assert.equal(cleanText('   ', 10), undefined);
  assert.equal(cleanText('ab\ncd', 10), 'ab cd');
});

test('source values, ported from the devialet library', () => {
  const sources = parseSources(
    {
      sources: [
        { sourceId: 'a', deviceId: DEVICE_ID, type: 'optical' },
        { sourceId: 'b', deviceId: PARTNER_ID, type: 'optical' },
        { sourceId: 'c', deviceId: DEVICE_ID, type: 'spotifyconnect' },
        { sourceId: 'd/../e', deviceId: DEVICE_ID, type: 'upnp' },
        { sourceId: 'f', deviceId: DEVICE_ID, type: 'Weird Type' },
        'junk',
      ],
    },
    32,
  );
  assert.equal(sources.length, 3, 'unsafe ids and types are dropped');
  const left = { deviceId: DEVICE_ID, role: 'FrontLeft' };
  const right = { deviceId: DEVICE_ID, role: 'FrontRight' };
  const mono = { deviceId: DEVICE_ID, role: 'Mono' };
  assert.deepEqual(sourceValues(sources, left), [
    'optical_left',
    'optical_right',
    'spotifyconnect',
  ]);
  // Seen from the right speaker, its own optical input is the right one.
  assert.deepEqual(sourceValues(sources, right), [
    'optical_left',
    'optical_right',
    'spotifyconnect',
  ]);
  assert.equal(sourceIdFor('optical_right', sources, right), 'a');
  assert.equal(sourceIdFor('optical_right', sources, left), 'b');
  assert.deepEqual(sourceValues(sources, mono), ['optical', 'spotifyconnect']);
  assert.equal(sourceIdFor('spotifyconnect', sources, mono), 'c');
  assert.equal(sourceIdFor('phono', sources, mono), undefined);
  assert.equal(sourceIdFor('__proto__', sources, mono), undefined);
  assert.equal(
    currentSourceValue({ source: { sourceId: 'b', deviceId: PARTNER_ID } }, sources, left),
    'optical_right',
  );
  assert.equal(currentSourceValue({ source: {} }, sources, left), undefined);
  assert.equal(parseSources({ sources: new Array(100).fill(sources[0]) }, 32).length, 32);
});

test('the source id is encoded in the path', () => {
  assert.equal(PATHS.playSource('a b'), '/ipcontrol/v1/groups/current/sources/a%20b/playback/play');
});

test('the client against the fake speaker', async (t) => {
  const speaker = await startFakeSpeaker();
  t.after(() => speaker.close());
  const client = new DevialetClient({ host: '127.0.0.1', port: speaker.port, timeoutMs: 1000 });
  assert.equal((await client.describe()).serial, SERIAL);
  assert.equal(await client.systemName(), 'Living room');
  assert.equal(await client.volume(), 30);
  await client.setVolume(12);
  assert.equal(speaker.state.volume, 12);
  assert.equal(speaker.posts()[0].body, '{"volume":12}');
  speaker.state.idle = true;
  await assert.rejects(client.playback(), { kind: ERROR_KINDS.API, code: 'NoCurrentSource' });
  speaker.state.hostile = true;
  await assert.rejects(client.describe(), { kind: ERROR_KINDS.PROTOCOL });
  assert.ok(MAX_BODY <= 64 * 1024);
});

test('error kinds: unreachable, connected but silent, budget', async (t) => {
  // A closed port: nothing accepts the connection.
  await assert.rejects(request({ host: '127.0.0.1', port: 1, path: '/', timeoutMs: 500 }), {
    kind: ERROR_KINDS.UNREACHABLE,
  });
  // A server that accepts and says nothing.
  const sockets = [];
  const server = createServer((socket) => sockets.push(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        sockets.forEach((s) => s.destroy());
        server.close(resolve);
      }),
  );
  await assert.rejects(
    request({ host: '127.0.0.1', port: server.address().port, path: '/', timeoutMs: 100 }),
    { kind: ERROR_KINDS.TIMEOUT },
  );
  const client = new DevialetClient({ host: '127.0.0.1', port: 1 }).withBudget(10);
  await assert.rejects(client.volume(), { kind: ERROR_KINDS.BUDGET });
});

test('an answer that is not a JSON object', async (t) => {
  const answers = ['[1,2]', 'not json', '"text"'];
  const fake = async () => ({ status: 200, body: answers.shift() });
  const client = new DevialetClient({ host: 'x', port: 80, request: fake });
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(client.volume(), { kind: ERROR_KINDS.PROTOCOL });
  }
  const http = new DevialetClient({
    host: 'x',
    port: 80,
    request: async () => ({ status: 500, body: '' }),
  });
  await assert.rejects(http.play(), { kind: ERROR_KINDS.HTTP });
  const api = new DevialetClient({
    host: 'x',
    port: 80,
    request: async () => ({ status: 200, body: '{"error":{"code":"<script>"}}' }),
  });
  await assert.rejects(api.play(), { kind: ERROR_KINDS.API, code: '?' });
  t.diagnostic('error codes are kept only when they are plain identifiers');
});
