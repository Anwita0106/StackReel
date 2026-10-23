// Classifies IP addresses. Anything that is not clearly a public unicast
// address is refused as a scan destination.
import net from 'node:net';

const blocked = new net.BlockList();

// IPv4 special-purpose ranges (RFC 6890 and friends).
const V4 = [
  ['0.0.0.0', 8, 'this-network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-grade-nat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local (includes cloud metadata 169.254.169.254)'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'ietf-protocol-assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4-relay'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
  ['255.255.255.255', 32, 'broadcast'],
];
// IPv6 special-purpose ranges.
const V6 = [
  ['::', 128, 'unspecified'],
  ['::1', 128, 'loopback'],
  ['::ffff:0:0', 96, 'ipv4-mapped'], // re-checked against the IPv4 list below
  ['64:ff9b:1::', 48, 'nat64-local'],
  ['100::', 64, 'discard'],
  ['2001::', 23, 'ietf-protocol-assignments'],
  ['2001:db8::', 32, 'documentation'],
  ['2002::', 16, '6to4'],
  ['fc00::', 7, 'unique-local'],
  ['fe80::', 10, 'link-local'],
  ['fec0::', 10, 'site-local'],
  ['ff00::', 8, 'multicast'],
];
for (const [addr, prefix] of V4) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of V6) if (addr !== '::ffff:0:0') blocked.addSubnet(addr, prefix, 'ipv6');

function reasonFor(address, family) {
  const table = family === 'ipv4' ? V4 : V6;
  for (const [addr, prefix, reason] of table) {
    const one = new net.BlockList();
    one.addSubnet(addr, prefix, family);
    if (one.check(address, family)) return reason;
  }
  return 'non-public';
}

/** Expands an IPv6 address to 8 four-digit groups (handles "::" and a dotted IPv4 tail). */
function expandIPv6(addr) {
  let a = addr;
  const v4 = a.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const [p, q, r, t] = v4[1].split('.').map(Number);
    a = a.slice(0, -v4[1].length) + `${((p << 8) | q).toString(16)}:${((r << 8) | t).toString(16)}`;
  }
  const [head, tail] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = a.includes('::') ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array(Math.max(0, fill)).fill('0'), ...t];
  return groups.length === 8 ? groups.map(g => g.padStart(4, '0')) : null;
}

/**
 * Returns `null` when the address is a public unicast destination, otherwise a
 * short human-readable reason why it is blocked.
 */
export function blockedReason(address) {
  const version = net.isIP(address);
  if (version === 0) return 'not-an-ip-address';
  if (version === 4) {
    return blocked.check(address, 'ipv4') ? reasonFor(address, 'ipv4') : null;
  }
  const lower = address.toLowerCase();
  // IPv4-mapped / IPv4-compatible IPv6 (::ffff:a.b.c.d or ::ffff:7f00:1) → evaluate embedded IPv4.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return blockedReason(mapped[1]);
  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052). Networks using DNS64 (common on
  // mobile/IPv6-only ISPs) wrap the site's real IPv4 address in it, so judge the
  // embedded IPv4: public → allowed, private/loopback/metadata → still blocked.
  const nat64 = expandIPv6(lower);
  if (nat64 && nat64.slice(0, 6).join(':') === '0064:ff9b:0000:0000:0000:0000') {
    const hi = parseInt(nat64[6], 16);
    const lo = parseInt(nat64[7], 16);
    const embedded = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    const inner = blockedReason(embedded);
    return inner ? `nat64-wrapped ${inner} (${embedded})` : null;
  }
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return blockedReason(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return blocked.check(address, 'ipv6') ? reasonFor(address, 'ipv6') : null;
}

export const isPublicAddress = (address) => blockedReason(address) === null;
