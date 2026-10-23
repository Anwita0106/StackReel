import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockedReason, isPublicAddress } from '../src/security/ipPolicy.js';
import { normalizeTargetUrl, checkHostAndPort, resolvePublicAddresses, createSafeLookup } from '../src/security/targetPolicy.js';

const policy = { allowedPorts: [80, 443, 8080, 8443], testAllowedTargets: [] };

test('blocks loopback, private, link-local, CGNAT, multicast, reserved and metadata addresses', () => {
  for (const ip of ['127.0.0.1', '127.8.8.8', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '240.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.10']) {
    assert.ok(blockedReason(ip), `${ip} should be blocked`);
  }
  assert.match(blockedReason('169.254.169.254'), /metadata/);
});

test('blocks IPv6 loopback, ULA, link-local, multicast and IPv4-mapped private addresses', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '2001:db8::1']) {
    assert.ok(blockedReason(ip), `${ip} should be blocked`);
  }
});

test('allows public unicast addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPublicAddress(ip), true, `${ip} should be allowed`);
  }
});

test('normalizes URLs with and without scheme, keeps explicit ports', () => {
  assert.equal(normalizeTargetUrl('example.com').href, 'https://example.com/');
  assert.equal(normalizeTargetUrl('  https://Example.com/path#frag ').href, 'https://example.com/path');
  assert.equal(normalizeTargetUrl('example.com:8080/x').href, 'https://example.com:8080/x');
  assert.equal(normalizeTargetUrl('http://example.com').protocol, 'http:');
});

test('rejects unsupported schemes, credentials, whitespace and empty input', () => {
  for (const bad of ['', '   ', 'javascript:alert(1)', 'ftp://example.com', 'file:///etc/passwd', 'mailto:a@b.c', 'https://user:pw@example.com', 'exa mple.com', 'data:text/html,hi']) {
    assert.throws(() => normalizeTargetUrl(bad), (e) => e.code === 'TARGET_NOT_ALLOWED', `should reject "${bad}"`);
  }
});

test('rejects internal hostnames, metadata hosts, single-label names, private IPs and disallowed ports', () => {
  const reject = (u) => assert.throws(() => checkHostAndPort(normalizeTargetUrl(u), policy), (e) => e.code === 'TARGET_NOT_ALLOWED', u);
  for (const u of ['localhost', 'http://localhost:5001', 'app.localhost', 'printer.local', 'db.internal', 'metadata.google.internal', 'intranet', 'http://127.0.0.1', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://10.0.0.5', 'example.com:22', 'example.com:6379']) reject(u);
  assert.doesNotThrow(() => checkHostAndPort(normalizeTargetUrl('example.com:8443'), policy));
});

test('rejects hostnames whose DNS answers include any non-public address', async () => {
  const resolver = { lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }] };
  await assert.rejects(resolvePublicAddresses('mixed.example', policy, { port: 443, resolver }), (e) => e.details.reason === 'private-dns');
});

test('safe lookup re-validates at connect time (DNS rebinding protection)', async () => {
  let calls = 0;
  const resolver = { lookup: async () => (++calls === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]) };
  const lookup = createSafeLookup(policy, { port: 443, resolver });
  const first = await new Promise((resolve, reject) => lookup('rebind.example', {}, (err, addr) => (err ? reject(err) : resolve(addr))));
  assert.equal(first, '93.184.216.34');
  // Second resolution flips to loopback: the connection must be refused.
  await assert.rejects(new Promise((resolve, reject) => lookup('rebind.example', {}, (err, addr) => (err ? reject(err) : resolve(addr)))), (e) => e.code === 'TARGET_NOT_ALLOWED');
});

test('test allow-list only permits exact host:port pairs', async () => {
  const p = { ...policy, testAllowedTargets: ['localhost:4000'] };
  assert.doesNotThrow(() => checkHostAndPort(normalizeTargetUrl('http://localhost:4000'), p));
  assert.throws(() => checkHostAndPort(normalizeTargetUrl('http://localhost:4001'), p));
});

test('NAT64 (DNS64 networks, e.g. mobile ISPs): wrapped public IPv4 is allowed, wrapped private is blocked', () => {
  assert.equal(blockedReason('64:ff9b::d8c6:4fc3'), null); // 216.198.79.195 (Vercel) as seen on a DNS64 network
  assert.equal(blockedReason('64:ff9b::216.198.79.195'), null);
  for (const ip of ['64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b::a00:1', '64:ff9b::c0a8:101', '64:ff9b:1::1']) {
    assert.ok(blockedReason(ip), `${ip} should stay blocked`);
  }
  assert.match(blockedReason('64:ff9b::a9fe:a9fe'), /169\.254\.169\.254/);
});

test('a host resolving to NAT64-wrapped public addresses passes validation', async () => {
  const resolver = { lookup: async () => [{ address: '64:ff9b::d8c6:4fc3', family: 6 }, { address: '64:ff9b::d8c6:4fc4', family: 6 }] };
  const records = await resolvePublicAddresses('path-mind-ai-pi.vercel.app', policy, { port: 443, resolver });
  assert.equal(records.length, 2);
});

test('momentary DNS failures are retried before giving up', async () => {
  let calls = 0;
  const flaky = { lookup: async () => { calls += 1; if (calls < 2) throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); return [{ address: '93.184.216.34', family: 4 }]; } };
  assert.equal((await resolvePublicAddresses('flaky.example', policy, { port: 443, resolver: flaky }))[0].address, '93.184.216.34');
  assert.equal(calls, 2);
  const dead = { lookup: async () => { throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' }); } };
  await assert.rejects(resolvePublicAddresses('does-not-exist.example', policy, { port: 443, resolver: dead }), (e) => /internet connection/.test(e.message));
});
