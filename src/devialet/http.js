// -----------------------------------------------------------------------------
// One plain HTTP/1.1 exchange with a speaker (node:http, no keep-alive, no
// redirect followed, bounded time and size). A speaker in standby or off the
// network does not answer: every failure to connect becomes a SpeakerError of
// kind 'unreachable', a speaker that accepted the connection and then said
// nothing a 'timeout' (something answered: not proof that it is off).
// -----------------------------------------------------------------------------

import { request as httpRequest } from 'node:http';

/** The largest answer of a speaker (its source list) is a few kilobytes. */
export const MAX_BODY = 64 * 1024;

/** The kinds of failure the rest of the code tells apart. */
export const ERROR_KINDS = Object.freeze({
  /** Nothing accepted the connection: off, standby or not on the network. Nothing was sent. */
  UNREACHABLE: 'unreachable',
  /** Connected, then silent: the request may have been received. */
  TIMEOUT: 'timeout',
  /** An HTTP status other than 2xx, without an API error. */
  HTTP: 'http',
  /** The speaker answered an API error (`{ "error": { "code": ... } }`). */
  API: 'api',
  /** Too large, not JSON, not the expected shape. */
  PROTOCOL: 'protocol',
  /** The time a command was given ran out before this request. */
  BUDGET: 'budget',
});

export class SpeakerError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'SpeakerError';
    this.kind = kind;
    Object.assign(this, details);
  }
}

/**
 * @param {{ host: string, port: number, method?: string, path: string,
 *   body?: string, timeoutMs?: number }} options
 * @returns {Promise<{ status: number, body: string }>}
 */
export function request({ host, port, method = 'GET', path, body, timeoutMs = 2000 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
    let settled = false;
    let connected = false;
    const finish = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    const failure = (err) =>
      connected
        ? new SpeakerError(ERROR_KINDS.TIMEOUT, `Connection lost: ${err.code ?? err.message}`)
        : new SpeakerError(ERROR_KINDS.UNREACHABLE, `Unreachable: ${err.code ?? err.message}`);
    const req = httpRequest(
      {
        host,
        port,
        method,
        path,
        agent: false,
        headers: {
          Connection: 'close',
          Accept: 'application/json',
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY) {
            req.destroy();
            finish(reject, new SpeakerError(ERROR_KINDS.PROTOCOL, 'Answer too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(resolve, {
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', (err) => finish(reject, failure(err)));
      },
    );
    req.on('socket', (socket) => {
      if (socket.connecting) {
        socket.once('connect', () => {
          connected = true;
        });
      } else {
        connected = true;
      }
    });
    // A plain (ref'd) timer: the exchange keeps the process alive until it ends.
    const timer = setTimeout(() => {
      req.destroy();
      finish(
        reject,
        connected
          ? new SpeakerError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout')
          : new SpeakerError(ERROR_KINDS.UNREACHABLE, 'Unreachable: timeout'),
      );
    }, timeoutMs);
    req.on('error', (err) => finish(reject, failure(err)));
    req.end(payload);
  });
}
