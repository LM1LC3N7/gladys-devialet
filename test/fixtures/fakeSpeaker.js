// -----------------------------------------------------------------------------
// A fake Devialet speaker on 127.0.0.1: the IP control endpoints the
// integration uses, with a state the tests read and change. Modes: `silent`
// (accepts the connection, never answers), `hostile` (huge answer), `idle`
// (no current source: API error). close() makes it unreachable.
// -----------------------------------------------------------------------------

import { createServer } from 'node:http';

export const SERIAL = 'R0123456789';
export const DEVICE_ID = 'aaaaaaaa-1111-4111-8111-000000000001';
export const PARTNER_ID = 'aaaaaaaa-1111-4111-8111-000000000002';
export const SYSTEM_ID = 'bbbbbbbb-2222-4222-8222-000000000001';

const BASE = '/ipcontrol/v1';

export async function startFakeSpeaker(options = {}) {
  const state = {
    serial: SERIAL,
    deviceId: DEVICE_ID,
    systemId: SYSTEM_ID,
    role: 'FrontLeft',
    leader: true,
    name: 'Phantom Left',
    systemName: 'Living room',
    model: 'Phantom I',
    volume: 30,
    muted: false,
    playing: true,
    idle: false,
    silent: false,
    hostile: false,
    current: 'src-spotify',
    sources: [
      { sourceId: 'src-spotify', deviceId: DEVICE_ID, type: 'spotifyconnect' },
      { sourceId: 'src-airplay', deviceId: DEVICE_ID, type: 'airplay2' },
      { sourceId: 'src-optical-l', deviceId: DEVICE_ID, type: 'optical' },
      { sourceId: 'src-optical-r', deviceId: PARTNER_ID, type: 'optical' },
      { sourceId: 'src-weird', deviceId: DEVICE_ID, type: 'not_a_known_type' },
    ],
    metadata: { artist: 'Daft Punk', title: 'Get Lucky', album: 'RAM' },
    poweredOff: false,
    requests: [],
    ...options,
  };
  const sockets = new Set();

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const error = (res, code) => json(res, 400, { error: { code, details: {}, message: code } });

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      state.requests.push({ method: req.method, path: req.url, body });
      if (state.silent) {
        return; // never answers
      }
      if (state.hostile) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(`{"serial":"${'x'.repeat(200 * 1024)}"}`);
        return;
      }
      const route = `${req.method} ${req.url}`;
      switch (route) {
        case `GET ${BASE}/devices/current`:
          return json(res, 200, {
            deviceId: state.deviceId,
            deviceName: state.name,
            systemId: state.systemId,
            groupId: 'group-1',
            isSystemLeader: state.leader,
            model: state.model,
            role: state.role,
            serial: state.serial,
            release: { version: '2.16.1' },
          });
        case `GET ${BASE}/systems/current`:
          return json(res, 200, { systemId: state.systemId, systemName: state.systemName });
        case `GET ${BASE}/groups/current/sources`:
          if (state.failSources) {
            return error(res, 'Busy');
          }
          return json(res, 200, { sources: state.sources });
        case `GET ${BASE}/groups/current/sources/current`: {
          if (state.idle) {
            return error(res, 'NoCurrentSource');
          }
          const source = state.sources.find((s) => s.sourceId === state.current);
          return json(res, 200, {
            availableOperations: ['play', 'pause', 'next', 'previous'],
            metadata: state.metadata,
            muteState: state.muted ? 'muted' : 'unmuted',
            playingState: state.playing ? 'playing' : 'paused',
            source: source ? { deviceId: source.deviceId, sourceId: source.sourceId } : {},
          });
        }
        case `GET ${BASE}/systems/current/sources/current/soundControl/volume`:
          return json(res, 200, { volume: state.volume });
        case `POST ${BASE}/systems/current/sources/current/soundControl/volume`: {
          const parsed = JSON.parse(body || '{}');
          state.volume = parsed.volume;
          return json(res, 200, {});
        }
        case `POST ${BASE}/groups/current/sources/current/playback/mute`:
          state.muted = true;
          return json(res, 200, {});
        case `POST ${BASE}/groups/current/sources/current/playback/unmute`:
          state.muted = false;
          return json(res, 200, {});
        case `POST ${BASE}/groups/current/sources/current/playback/play`:
          state.playing = true;
          return json(res, 200, {});
        case `POST ${BASE}/groups/current/sources/current/playback/pause`:
          state.playing = false;
          return json(res, 200, {});
        case `POST ${BASE}/groups/current/sources/current/playback/next`:
        case `POST ${BASE}/groups/current/sources/current/playback/previous`:
          return json(res, 200, {});
        case `POST ${BASE}/systems/current/powerOff`:
          state.poweredOff = true;
          return json(res, 200, {});
        default: {
          const match = req.url.match(
            /^\/ipcontrol\/v1\/groups\/current\/sources\/([^/]+)\/playback\/play$/,
          );
          if (req.method === 'POST' && match) {
            const id = decodeURIComponent(match[1]);
            if (!state.sources.some((s) => s.sourceId === id)) {
              return error(res, 'InvalidSource');
            }
            state.current = id;
            state.playing = true;
            return json(res, 200, {});
          }
          return error(res, 'NotFound');
        }
      }
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    state,
    posts: () => state.requests.filter((r) => r.method === 'POST'),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  };
}
