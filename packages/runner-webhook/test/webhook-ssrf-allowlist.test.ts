// Webhook SSRF / allowlist guard (§9B webhook safety). Deny-by-default per-workspace
// HOST allowlist + a literal-IP/host SSRF refusal (loopback, 169.254 metadata,
// RFC1918, IPv6 ULA/loopback), http(s)-only. The guard runs BEFORE any HTTP call;
// a blocked target NEVER reaches the injected client.
import { describe, it, expect } from 'vitest';
import {
  assertWebhookTargetAllowed,
  isPrivateOrReservedHost,
  BlockedTargetError,
} from '../src/ssrf.js';

const ALLOW = ['hooks.example.com'];

describe('isPrivateOrReservedHost', () => {
  it('classifies loopback / metadata / RFC1918 / IPv6 ULA as private', () => {
    expect(isPrivateOrReservedHost('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedHost('localhost')).toBe(true);
    expect(isPrivateOrReservedHost('::1')).toBe(true);
    expect(isPrivateOrReservedHost('169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedHost('169.254.0.1')).toBe(true);
    expect(isPrivateOrReservedHost('10.0.0.5')).toBe(true);
    expect(isPrivateOrReservedHost('172.16.0.1')).toBe(true);
    expect(isPrivateOrReservedHost('172.31.255.255')).toBe(true);
    expect(isPrivateOrReservedHost('192.168.1.1')).toBe(true);
    expect(isPrivateOrReservedHost('fc00::1')).toBe(true);
    expect(isPrivateOrReservedHost('fd12:3456::1')).toBe(true);
  });
  it('does NOT classify public names / IPs as private', () => {
    expect(isPrivateOrReservedHost('hooks.example.com')).toBe(false);
    expect(isPrivateOrReservedHost('8.8.8.8')).toBe(false);
    expect(isPrivateOrReservedHost('172.32.0.1')).toBe(false); // just outside 172.16/12
    expect(isPrivateOrReservedHost('11.0.0.1')).toBe(false);
  });
  it('canonicalizes numeric IPv4 encodings of loopback before classifying', () => {
    expect(isPrivateOrReservedHost('2130706433')).toBe(true); // decimal 127.0.0.1
    expect(isPrivateOrReservedHost('0x7f000001')).toBe(true); // hex 127.0.0.1
    expect(isPrivateOrReservedHost('0177.0.0.1')).toBe(true); // octal-first-octet 127.0.0.1
    // decimal encoding of the 169.254.169.254 metadata endpoint
    expect(isPrivateOrReservedHost('2852039166')).toBe(true);
  });
  it('classifies the added reserved ranges (CGNAT / protocol / benchmarking)', () => {
    expect(isPrivateOrReservedHost('100.64.0.1')).toBe(true); // 100.64/10 CGNAT
    expect(isPrivateOrReservedHost('192.0.0.8')).toBe(true); // 192.0.0/24
    expect(isPrivateOrReservedHost('198.18.0.1')).toBe(true); // 198.18/15
    expect(isPrivateOrReservedHost('100.128.0.1')).toBe(false); // outside 100.64/10
  });
});

describe('assertWebhookTargetAllowed', () => {
  it('throws for loopback hosts', () => {
    expect(() => assertWebhookTargetAllowed('http://127.0.0.1/x', ALLOW)).toThrow(BlockedTargetError);
    expect(() => assertWebhookTargetAllowed('http://localhost/x', ALLOW)).toThrow(BlockedTargetError);
    expect(() => assertWebhookTargetAllowed('http://[::1]/x', ALLOW)).toThrow(BlockedTargetError);
  });
  it('throws for link-local / metadata 169.254.0.0/16', () => {
    expect(() => assertWebhookTargetAllowed('http://169.254.169.254/latest/meta-data', ALLOW)).toThrow(
      BlockedTargetError,
    );
    expect(() => assertWebhookTargetAllowed('http://169.254.0.5/', ALLOW)).toThrow(BlockedTargetError);
  });
  it('throws for RFC1918 + IPv6 ULA', () => {
    expect(() => assertWebhookTargetAllowed('http://10.0.0.1/', ALLOW)).toThrow(BlockedTargetError);
    expect(() => assertWebhookTargetAllowed('http://172.16.0.1/', ALLOW)).toThrow(BlockedTargetError);
    expect(() => assertWebhookTargetAllowed('http://192.168.0.1/', ALLOW)).toThrow(BlockedTargetError);
    expect(() => assertWebhookTargetAllowed('http://[fc00::1]/', ALLOW)).toThrow(BlockedTargetError);
  });
  it('throws for a non-http(s) scheme', () => {
    expect(() => assertWebhookTargetAllowed('file:///etc/passwd', ALLOW)).toThrow(BlockedTargetError);
    expect(() => assertWebhookTargetAllowed('gopher://hooks.example.com/', ALLOW)).toThrow(BlockedTargetError);
    expect(() => assertWebhookTargetAllowed('ftp://hooks.example.com/', ALLOW)).toThrow(BlockedTargetError);
  });
  it('throws when the host is NOT on the per-workspace allowlist', () => {
    expect(() => assertWebhookTargetAllowed('https://api.evil.com/hook', ALLOW)).toThrow(BlockedTargetError);
  });
  it('allows an allowlisted public host (exact host match)', () => {
    expect(() => assertWebhookTargetAllowed('https://hooks.example.com/abc', ALLOW)).not.toThrow();
  });
  it('allows a subdomain ONLY via an explicit leading-dot suffix entry', () => {
    // exact entry does NOT cover a subdomain
    expect(() => assertWebhookTargetAllowed('https://api.hooks.example.com/x', ALLOW)).toThrow(
      BlockedTargetError,
    );
    // a ".hooks.example.com" entry is an explicit suffix match for subdomains
    expect(() =>
      assertWebhookTargetAllowed('https://api.hooks.example.com/x', ['.hooks.example.com']),
    ).not.toThrow();
    // the suffix entry also covers the apex
    expect(() =>
      assertWebhookTargetAllowed('https://hooks.example.com/x', ['.hooks.example.com']),
    ).not.toThrow();
  });
  it('an EMPTY allowlist refuses ALL hosts (deny-by-default)', () => {
    expect(() => assertWebhookTargetAllowed('https://hooks.example.com/x', [])).toThrow(BlockedTargetError);
  });
});
