// Webhook SSRF / allowlist guard (§9B webhook safety). Outbound HTTP from a
// automation webhook action is OPT-IN per workspace: a deny-by-default HOST
// allowlist (stored in workspaces.settings, never client-trusted) PLUS a
// literal-IP/host classifier that refuses loopback, the 169.254 link-local /
// cloud-metadata range, RFC1918 private ranges and IPv6 ULA/loopback, and any
// non-http(s) scheme. The guard runs BEFORE any client call so a blocked target
// never reaches the network.
//
// SCOPE NOTE (resolution-time SSRF): this enforces the LITERAL host/IP + the
// per-workspace allowlist. A hostname that DNS-resolves to a private IP is
// defended in depth by (a) the deny-by-default allowlist (only explicitly trusted
// public hosts are reachable) and (b) the deploy-time egress network policy of the
// runner Lambda's VPC/subnet. We do not perform a synchronous DNS resolve here.

/** Thrown when a webhook target is refused by the allowlist or the SSRF rules. */
export class BlockedTargetError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'BlockedTargetError';
  }
}

/** Strip an IPv6 bracket/zone and lowercase a host for comparison. */
function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const pct = h.indexOf('%'); // IPv6 zone id
  if (pct >= 0) h = h.slice(0, pct);
  return h;
}

/** Parse a single IPv4 octet in decimal, 0x-hex, or 0-octal, or null. */
function parseOctet(s: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
  if (/^0[0-7]+$/.test(s)) return parseInt(s, 8);
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return null;
}

/**
 * Parse an IPv4 address in ANY of the encodings a URL parser accepts and
 * `inet_aton` resolves — dotted-quad, but also a single 32-bit integer
 * (`2130706433`), hex (`0x7f000001`), or octal octets (`0177.0.0.1`) — into its
 * four canonical octets, or null if it isn't an IPv4 literal. Canonicalizing
 * BEFORE classifying stops a numeric-encoded loopback/metadata address slipping
 * past `isPrivateOrReservedHost` as a "regular DNS name".
 */
function ipv4Octets(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length === 1) {
    const n = parseOctet(parts[0]!);
    if (n === null || n < 0 || n > 0xffffffff) return null;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }
  if (parts.length === 4) {
    const nums = parts.map(parseOctet);
    if (nums.some((n) => n === null || n < 0 || n > 255)) return null;
    return nums as [number, number, number, number];
  }
  return null;
}

/**
 * Classify a host as private / reserved (an SSRF target we always refuse,
 * regardless of the allowlist). Covers: `localhost`, IPv4 loopback (127/8),
 * link-local / cloud-metadata (169.254/16), RFC1918 (10/8, 172.16/12, 192.168/16),
 * IPv4 "this host" (0.0.0.0/8), IPv6 loopback (::1) and Unique-Local (fc00::/7,
 * i.e. an fc.. or fd.. prefix).
 */
export function isPrivateOrReservedHost(host: string): boolean {
  const h = normalizeHost(host);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '::') return true;
  // IPv6 Unique-Local (fc00::/7) — first byte 0xfc or 0xfd.
  if (h.includes(':')) {
    const first = h.split(':')[0] ?? '';
    if (/^f[cd][0-9a-f]{0,2}$/.test(first)) return true;
    // a mapped IPv4 (::ffff:10.0.0.1) — pull the trailing v4 if present
    const v4 = h.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4 && isPrivateOrReservedHost(v4[1]!)) return true;
    return false;
  }
  const oct = ipv4Octets(h);
  if (!oct) return false; // a regular DNS name — not a literal private IP
  const [a, b] = oct;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT (RFC6598)
  if (a === 192 && b === 0 && oct[2] === 0) return true; // 192.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  return false;
}

/** Does the URL host satisfy the per-workspace allowlist (exact OR dotted-suffix)? */
function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const h = normalizeHost(host);
  for (const raw of allowlist) {
    const entry = normalizeHost(raw);
    if (entry.length === 0) continue;
    if (entry.startsWith('.')) {
      // explicit suffix match: ".hooks.example.com" covers the apex + any subdomain
      const apex = entry.slice(1);
      if (h === apex || h.endsWith(entry)) return true;
    } else if (h === entry) {
      return true;
    }
  }
  return false;
}

/**
 * Refuse a webhook target that is not safe to call. THROWS {@link BlockedTargetError}
 * when: the URL is unparseable, the scheme is not http(s), the host is a private /
 * reserved IP (SSRF), or the host is not on the per-workspace allowlist
 * (deny-by-default). Returns normally for an allowed public target.
 */
export function assertWebhookTargetAllowed(url: string, allowlist: readonly string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BlockedTargetError('webhook url is not a valid url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BlockedTargetError(`webhook url scheme "${parsed.protocol}" is not http(s)`);
  }
  const host = normalizeHost(parsed.hostname);
  if (isPrivateOrReservedHost(host)) {
    throw new BlockedTargetError(`webhook target host "${host}" is a private/reserved address`);
  }
  if (!hostAllowed(host, allowlist)) {
    throw new BlockedTargetError(`webhook target host "${host}" is not on the workspace allowlist`);
  }
}
