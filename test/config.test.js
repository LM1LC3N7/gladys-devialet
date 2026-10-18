import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, parseAddress } from '../src/config.js';
import { POLL_INTERVAL } from '../src/constants.js';

test('addresses: IPv4 or host name, optional port, URL reduced', () => {
  assert.deepEqual(parseAddress('192.168.1.20'), { host: '192.168.1.20', port: 80 });
  assert.deepEqual(parseAddress('http://192.168.1.20:8080/x'), {
    host: '192.168.1.20',
    port: 8080,
  });
  assert.deepEqual(parseAddress('Phantom.local'), { host: 'phantom.local', port: 80 });
  for (const bad of ['', '999.1.1.1', '1.2.3', 'a b', 'host:0', 'host:70000', '-x.local', null]) {
    assert.equal(parseAddress(bad), undefined, String(bad));
  }
});

test('normalizeConfig', () => {
  const config = normalizeConfig({
    addresses: '192.168.1.20, 192.168.1.20;192.168.1.21:80 nope!',
    poll_interval: '2',
  });
  assert.deepEqual(
    config.addresses.map((a) => a.host),
    ['192.168.1.20', '192.168.1.21'],
  );
  assert.deepEqual(config.invalid, ['nope!']);
  assert.equal(config.pollInterval, POLL_INTERVAL.min);
  assert.equal(normalizeConfig({ poll_interval: 'abc' }).pollInterval, POLL_INTERVAL.default);
  assert.equal(normalizeConfig({ poll_interval: 9999 }).pollInterval, POLL_INTERVAL.max);
  assert.deepEqual(normalizeConfig().addresses, []);
  assert.equal(DEFAULT_CONFIG.poll_interval, POLL_INTERVAL.default);
});
