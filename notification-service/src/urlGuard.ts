import { promises as dns } from 'dns';
import { isIPv4, isIPv6 } from 'net';

/**
 * Error thrown when a webhook URL is rejected by the SSRF guard.
 * Callers should map this to an HTTP 403 Forbidden response.
 */
export class WebhookUrlBlockedError extends Error {
  public readonly code = 'WEBHOOK_URL_BLOCKED';

  constructor(message: string) {
    super(message);
    this.name = 'WebhookUrlBlockedError';
    Object.setPrototypeOf(this, WebhookUrlBlockedError.prototype);
  }
}

/**
 * Known cloud metadata hostnames that must never be reachable.
 */
const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
]);

/**
 * Parse an IPv4 address into its four octets, or return null if invalid.
 */
function parseIPv4(address: string): number[] | null {
  if (!isIPv4(address)) {
    return null;
  }
  const parts = address.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return parts;
}

/**
 * Check whether an IPv4 address falls within a CIDR block.
 */
function ipv4InCidr(address: string, cidr: string): boolean {
  const addr = parseIPv4(address);
  if (!addr) {
    return false;
  }
  const [network, prefixStr] = cidr.split('/');
  const net = parseIPv4(network);
  if (!net) {
    return false;
  }
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }

  const addrNum = ((addr[0] << 24) | (addr[1] << 16) | (addr[2] << 8) | addr[3]) >>> 0;
  const netNum = ((net[0] << 24) | (net[1] << 16) | (net[2] << 8) | net[3]) >>> 0;

  if (prefix === 0) {
    return true;
  }
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (addrNum & mask) === (netNum & mask);
}

/**
 * IPv4 ranges that must be blocked (private, loopback, link-local, CGNAT, etc.).
 */
export const BLOCKED_IPV4_CIDRS: readonly string[] = [
  '0.0.0.0/8', // "This" network
  '10.0.0.0/8', // Private
  '100.64.0.0/10', // Carrier-grade NAT
  '127.0.0.0/8', // Loopback
  '169.254.0.0/16', // Link-local (incl. cloud metadata)
  '172.16.0.0/12', // Private
  '192.168.0.0/16', // Private
];

/**
 * Check whether an IPv4 address is in any blocked range.
 */
export function isBlockedIPv4(address: string): boolean {
  if (!isIPv4(address)) {
    return false;
  }
  return BLOCKED_IPV4_CIDRS.some((cidr) => ipv4InCidr(address, cidr));
}

/**
 * Expand an IPv6 address into its eight 16-bit groups.
 * Handles "::" compression and embedded IPv4 (e.g. ::ffff:1.2.3.4).
 * Returns null if the address cannot be parsed.
 */
function parseIPv6(address: string): number[] | null {
  if (!isIPv6(address)) {
    return null;
  }

  let addr = address;

  // Strip zone index (e.g. fe80::1%eth0)
  const zoneIndex = addr.indexOf('%');
  if (zoneIndex !== -1) {
    addr = addr.slice(0, zoneIndex);
  }

  // Handle embedded IPv4 tail (e.g. ::ffff:192.168.0.1)
  let ipv4Tail: number[] | null = null;
  const lastColon = addr.lastIndexOf(':');
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes('.')) {
    const v4 = parseIPv4(addr.slice(lastColon + 1));
    if (!v4) {
      return null;
    }
    ipv4Tail = v4;
    addr = addr.slice(0, lastColon + 1) + '0:0';
  }

  const doubleColon = addr.indexOf('::');
  let head: string[];
  let tail: string[];

  if (doubleColon !== -1) {
    const headStr = addr.slice(0, doubleColon);
    const tailStr = addr.slice(doubleColon + 2);
    head = headStr.length > 0 ? headStr.split(':') : [];
    tail = tailStr.length > 0 ? tailStr.split(':') : [];
  } else {
    head = addr.split(':');
    tail = [];
  }

  const missing = 8 - (head.length + tail.length);
  if (missing < 0) {
    return null;
  }

  const groups: number[] = [];
  for (const g of head) {
    const n = parseInt(g, 16);
    if (Number.isNaN(n) || n < 0 || n > 0xffff) {
      return null;
    }
    groups.push(n);
  }
  for (let i = 0; i < missing; i++) {
    groups.push(0);
  }
  for (const g of tail) {
    const n = parseInt(g, 16);
    if (Number.isNaN(n) || n < 0 || n > 0xffff) {
      return null;
    }
    groups.push(n);
  }

  if (groups.length !== 8) {
    return null;
  }

  // Re-apply embedded IPv4 if present.
  if (ipv4Tail) {
    groups[6] = (ipv4Tail[0] << 8) | ipv4Tail[1];
    groups[7] = (ipv4Tail[2] << 8) | ipv4Tail[3];
  }

  return groups;
}

/**
 * Check whether an IPv6 address is in a blocked range.
 * Covers ::1 (loopback), fc00::/7 (unique local), fe80::/10 (link-local),
 * and IPv4-mapped addresses (::ffff:0:0/96) whose embedded IPv4 is blocked.
 */
export function isBlockedIPv6(address: string): boolean {
  const groups = parseIPv6(address);
  if (!groups) {
    return false;
  }

  // ::1 loopback
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
    return true;
  }

  // :: unspecified
  if (groups.every((g) => g === 0)) {
    return true;
  }

  // fc00::/7 unique local (fc00 - fdff)
  if ((groups[0] & 0xfe00) === 0xfc00) {
    return true;
  }

  // fe80::/10 link-local
  if ((groups[0] & 0xffc0) === 0xfe80) {
    return true;
  }

  // IPv4-mapped ::ffff:0:0/96
  const isMapped =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff;
  if (isMapped) {
    const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isBlockedIPv4(v4);
  }

  // IPv4-compatible ::/96 (deprecated but still resolvable)
  if (groups.slice(0, 6).every((g) => g === 0)) {
    const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    if (isBlockedIPv4(v4)) {
      return true;
    }
  }

  return false;
}

/**
 * Check whether a resolved IP address (v4 or v6) is blocked.
 */
export function isBlockedAddress(address: string): boolean {
  if (isIPv4(address)) {
    return isBlockedIPv4(address);
  }
  if (isIPv6(address)) {
    return isBlockedIPv6(address);
  }
  // Unknown address family: fail closed.
  return true;
}

/**
 * Check whether a hostname is a known blocked metadata hostname.
 */
export function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return BLOCKED_HOSTNAMES.has(normalized);
}

/**
 * Validate a webhook URL for SSRF safety.
 *
 * - Requires HTTPS.
 * - Rejects literal IP hosts and known metadata hostnames.
 * - Resolves the hostname and rejects if any resolved address is in a
 *   blocked private/loopback/link-local range.
 *
 * Throws {@link WebhookUrlBlockedError} on rejection.
 */
export async function validateWebhookUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new WebhookUrlBlockedError('Invalid webhook URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new WebhookUrlBlockedError('Webhook URL must use HTTPS');
  }

  // URL.hostname strips brackets from IPv6 literals.
  const hostname = parsed.hostname;

  if (!hostname) {
    throw new WebhookUrlBlockedError('Webhook URL must include a hostname');
  }

  // Reject literal IP addresses outright.
  if (isIPv4(hostname) || isIPv6(hostname)) {
    throw new WebhookUrlBlockedError('Webhook URL must not use a literal IP address');
  }

  if (isBlockedHostname(hostname)) {
    throw new WebhookUrlBlockedError('Webhook URL hostname is not allowed');
  }

  let records: dns.LookupAddress[];
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    throw new WebhookUrlBlockedError('Webhook URL hostname could not be resolved');
  }

  if (!records || records.length === 0) {
    throw new WebhookUrlBlockedError('Webhook URL hostname could not be resolved');
  }

  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      throw new WebhookUrlBlockedError(
        'Webhook URL resolves to a blocked address',
      );
    }
  }
}