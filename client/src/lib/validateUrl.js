// Client-side URL validation for instant feedback. The server re-validates
// everything (including DNS and private-address checks) — this is only UX.
const INTERNAL = /(^localhost$|\.localhost$|\.local$|\.internal$|\.lan$|\.home\.arpa$)/i;
const PRIVATE_V4 = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

export function validateUrlInput(raw) {
  const value = (raw || '').trim();
  if (!value) return { ok: false, error: 'Enter a website address, for example stripe.com' };
  if (/\s/.test(value)) return { ok: false, error: 'URLs cannot contain spaces.' };
  let candidate = value;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(candidate)) return { ok: false, error: 'Only http:// and https:// addresses can be analyzed.' };
    candidate = `https://${candidate}`;
  }
  let url;
  try { url = new URL(candidate); } catch { return { ok: false, error: 'That does not look like a valid web address.' }; }
  if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, error: 'Only http:// and https:// addresses can be analyzed.' };
  if (url.username || url.password) return { ok: false, error: 'Remove the username/password from the URL.' };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (INTERNAL.test(host) || PRIVATE_V4.test(host) || host === '::1') return { ok: false, error: 'Local and private network addresses cannot be analyzed.' };
  if (!host.includes('.') && !host.includes(':')) return { ok: false, error: 'Use a full domain name, such as example.com.' };
  return { ok: true, url: url.href, host };
}
