// Pure unit tests for resolveIdentity — the email/phone validation + normalization rules.
import { describe, it, expect } from 'vitest';
import { resolveIdentity, stripReservedAttributes } from '../src/identity.js';

const opts = (defaultCountry: string | null = 'IL') => ({ defaultCountry, emailPolicy: (e: string) => e.toLowerCase() });

describe('resolveIdentity', () => {
  it('email only → kept (lowercased)', () => {
    const r = resolveIdentity({ email: 'A@B.com' }, opts());
    expect(r).toEqual({ ok: true, identity: { email: 'a@b.com', phone: null } });
  });

  it('phone only (IL national) → normalized to E.164', () => {
    const r = resolveIdentity({ phone: '054-1111111' }, opts('IL'));
    expect(r.ok && r.identity).toEqual({ email: null, phone: '+972541111111' });
  });

  it('+972 and national IL forms resolve to the SAME E.164', () => {
    const a = resolveIdentity({ phone: '+972541111111' }, opts('IL'));
    const b = resolveIdentity({ phone: '054-1111111' }, opts('IL'));
    expect(a.ok && b.ok && a.identity.phone).toBe(b.ok ? b.identity.phone : null);
  });

  it('both → both kept', () => {
    const r = resolveIdentity({ email: 'x@y.com', phone: '0541111111' }, opts('IL'));
    expect(r.ok && r.identity).toEqual({ email: 'x@y.com', phone: '+972541111111' });
  });

  it('bad phone WITH a valid email → phone dropped, record kept', () => {
    const r = resolveIdentity({ email: 'x@y.com', phone: 'not-a-number' }, opts('IL'));
    expect(r.ok && r.identity).toEqual({ email: 'x@y.com', phone: null });
  });

  it('bad phone-ONLY → rejected (no reliable identity)', () => {
    const r = resolveIdentity({ phone: 'not-a-number' }, opts('IL'));
    expect(r.ok).toBe(false);
  });

  it('national phone-only with NO default country → rejected', () => {
    const r = resolveIdentity({ phone: '0541111111' }, opts(null));
    expect(r.ok).toBe(false);
  });

  it('neither email nor phone → rejected', () => {
    expect(resolveIdentity({}, opts()).ok).toBe(false);
    expect(resolveIdentity({ email: '', phone: '' }, opts()).ok).toBe(false);
  });

  it('malformed email (no phone) → rejected', () => {
    expect(resolveIdentity({ email: 'nope' }, opts()).ok).toBe(false);
  });
});

describe('stripReservedAttributes', () => {
  it('removes email/phone (reserved core fields); keeps dynamic attributes', () => {
    expect(stripReservedAttributes({ email: 'a@b.com', phone: '+972', tier: 'vip', city: 'TLV' })).toEqual({
      tier: 'vip',
      city: 'TLV',
    });
  });
});
