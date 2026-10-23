// URL normalization and outbound-destination policy shared by the HTTP
// inspector, the TLS probe and the browser egress proxy.
import dns from 'node:dns';
import net from 'node:net';
import { TargetPolicyError } from '../lib/errors.js';
import { blockedReason } from './ipPolicy.js';

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa', '.corp'];
const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata', 'instance-data', 'metadata.azure.com']);

/**
 * Normalizes user input into a URL object. Accepts "example.com",
 * "https://example.com/path" and "http://example.com:8080".
 */
export function normalizeTargetUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new TargetPolicyError('Enter a website address such as example.com.', 'empty');
  }
  let raw = input.trim();
  if (raw.length > 2048) throw new TargetPolicyError('That URL is too long (2048 characters max).', 'too-long');
  if (/\s/.test(raw)) throw new TargetPolicyError('URLs cannot contain spaces.', 'whitespace');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^:]+:\d+/.test(raw)) {
      throw new TargetPolicyError('Only http:// and https:// URLs can be analyzed.', 'scheme');
    }
    raw = `https://${raw}`;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TargetPolicyError('That does not look like a valid URL.', 'parse');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TargetPolicyError('Only http:// and https:// URLs can be analyzed.', 'scheme');
  }
  if (url.username || url.password) {
    throw new TargetPolicyError('URLs containing credentials are not accepted.', 'credentials');
  }
  url.hash = '';
  return url;
}

export function effectivePort(url) {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

/** Hostname-level checks that do not need DNS. */
export function checkHostAndPort(url, policy) {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = effectivePort(url);
  const testPair = `${host}:${port}`;
  const testAllowed = policy.testAllowedTargets?.includes(testPair);

  if (!host) throw new TargetPolicyError('The URL has no hostname.', 'no-host');
  if (!testAllowed) {
    if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some(s => host.endsWith(s)) || METADATA_HOSTS.has(host)) {
      throw new TargetPolicyError('Local, internal and cloud-metadata hostnames cannot be analyzed.', 'internal-hostname');
    }
    if (net.isIP(host) === 0 && !host.includes('.')) {
      throw new TargetPolicyError('Use a fully qualified public domain name (for example example.com).', 'single-label');
    }
    if (!policy.allowedPorts.includes(port)) {
      throw new TargetPolicyError(`Port ${port} is not permitted. Allowed ports: ${policy.allowedPorts.join(', ')}.`, 'port');
    }
    if (net.isIP(host)) {
      const reason = blockedReason(host);
      if (reason) throw new TargetPolicyError(`That address is not a public destination (${reason}).`, 'private-ip');
    }
  }
  return { host, port, testAllowed };
}

/**
 * Resolves a hostname and returns only validated public addresses.
 * Rejects the whole host when ANY resolved address is non-public, which
 * defeats "mixed" records that pair a public and an internal address.
 */
export async function resolvePublicAddresses(host, policy, { port, resolver = dns.promises } = {}) {
  if (net.isIP(host)) {
    const allowed = policy.testAllowedTargets?.includes(`${host}:${port}`);
    const reason = blockedReason(host);
    if (reason && !allowed) throw new TargetPolicyError(`That address is not a public destination (${reason}).`, 'private-ip');
    return [{ address: host, family: net.isIP(host) }];
  }
  let records;
  try {
    const mapped = policy.testHostMap?.[host];
    if (mapped) records = [{ address: mapped, family: net.isIP(mapped) }];
    else {
      // DNS on home/mobile networks occasionally fails for a moment: retry briefly before giving up.
      for (let attempt = 1; ; attempt += 1) {
        try { records = await resolver.lookup(host, { all: true, verbatim: true }); break; } catch (e) {
          if (attempt >= 3 || !['ENOTFOUND', 'EAI_AGAIN', 'ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED'].includes(e.code)) throw e;
          await new Promise(r => setTimeout(r, 700 * attempt));
        }
      }
    }
  } catch (err) {
    const hint = ['ENOTFOUND', 'EAI_AGAIN'].includes(err.code) ? ' Check the spelling and your internet connection, then press Retry.' : '';
    throw new TargetPolicyError(`The hostname "${host}" could not be resolved (${err.code || err.message}).${hint}`, 'dns');
  }
  if (!records?.length) throw new TargetPolicyError(`The hostname "${host}" has no addresses.`, 'dns-empty');
  const allowed = policy.testAllowedTargets?.includes(`${host}:${port}`);
  if (!allowed) {
    for (const r of records) {
      const reason = blockedReason(r.address);
      if (reason) {
        throw new TargetPolicyError(`"${host}" resolves to a non-public address (${r.address}: ${reason}). It cannot be analyzed.`, 'private-dns');
      }
    }
  }
  return records;
}

/**
 * Full validation of a URL as an outbound destination.
 * Returns { url, host, port, addresses }.
 */
export async function validateTarget(input, policy, opts = {}) {
  const url = input instanceof URL ? input : normalizeTargetUrl(input);
  const { host, port } = checkHostAndPort(url, policy);
  const addresses = await resolvePublicAddresses(host, policy, { port, resolver: opts.resolver });
  return { url, host, port, addresses };
}

/**
 * A `lookup` function for net/tls/undici sockets. It re-resolves and
 * re-validates at connection time and pins the socket to the validated
 * address, so a DNS answer cannot change between "check" and "connect"
 * (DNS rebinding protection).
 */
export function createSafeLookup(policy, { port, resolver } = {}) {
  return function safeLookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    resolvePublicAddresses(hostname, policy, { port, resolver })
      .then((records) => {
        if (options?.all) return callback(null, records.map(r => ({ address: r.address, family: r.family })));
        const pick = records.find(r => r.family === 4) || records[0];
        callback(null, pick.address, pick.family);
      })
      .catch((err) => callback(err));
  };
}
