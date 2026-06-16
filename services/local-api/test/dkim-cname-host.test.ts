// The DKIM CNAME target host (§10): we PREFER the SigningHostedZone SES reports
// (region-specific, authoritative — what the SES console shows) over any host we
// could construct. This is multi-region: every company picks its own SES region,
// so the value must come from SES, not a hardcoded rule. No DB needed.
import { describe, it, expect } from 'vitest';
import { dkimCnameHost } from '../src/handlers.js';

describe('dkimCnameHost', () => {
  it('uses the SES-reported SigningHostedZone verbatim (wins over region)', () => {
    // e.g. il-central-1 reports a region-specific zone — use it exactly.
    expect(dkimCnameHost('dkim.il-central-1.amazonses.com', 'us-east-1')).toBe('dkim.il-central-1.amazonses.com');
    expect(dkimCnameHost('dkim.ap-southeast-2.amazonses.com', null)).toBe('dkim.ap-southeast-2.amazonses.com');
  });

  it('falls back to a region-qualified host when SES did not report a zone', () => {
    expect(dkimCnameHost(null, 'eu-west-1')).toBe('dkim.eu-west-1.amazonses.com');
  });

  it('falls back to the legacy default with neither zone nor region', () => {
    expect(dkimCnameHost(null, null)).toBe('dkim.amazonses.com');
  });
});
