// Company-logo helpers (pure). No I/O — the reader is a tiny fake.
import { describe, it, expect } from 'vitest';
import { logoImgTag, resolveCompanyLogoAssetId, renderCompanyLogo } from '../src/logo.js';

const ASSET = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function reader(value: string | null | { throws: true }) {
  return {
    async query() {
      if (value && typeof value === 'object' && 'throws' in value) throw new Error('boom');
      return { rows: [{ logo_asset_id: value as string | null }] };
    },
  };
}

describe('logoImgTag', () => {
  it('builds an <img> at <base>/assets/<id> with the page-logo testid', () => {
    const html = logoImgTag(ASSET, 'https://app.example');
    expect(html).toContain(`src="https://app.example/assets/${ASSET}"`);
    expect(html).toContain('data-testid="page-logo"');
    expect(html).toContain('max-height:48px');
  });

  it('strips trailing slashes on the base', () => {
    expect(logoImgTag(ASSET, 'https://app.example/')).toContain(`https://app.example/assets/${ASSET}`);
  });

  it('returns "" for no asset, no base, or a malformed id', () => {
    expect(logoImgTag(null, 'https://app.example')).toBe('');
    expect(logoImgTag(ASSET, '')).toBe('');
    expect(logoImgTag(ASSET, undefined)).toBe('');
    expect(logoImgTag('not-a-uuid', 'https://app.example')).toBe('');
  });
});

describe('resolveCompanyLogoAssetId', () => {
  it('returns the asset id or null', async () => {
    expect(await resolveCompanyLogoAssetId(reader(ASSET), 'ws')).toBe(ASSET);
    expect(await resolveCompanyLogoAssetId(reader(null), 'ws')).toBe(null);
  });
  it('throws on a falsy workspaceId (tenancy guard)', async () => {
    await expect(resolveCompanyLogoAssetId(reader(ASSET), '')).rejects.toThrow(/workspaceId is required/);
  });
});

describe('renderCompanyLogo', () => {
  it('renders the <img> when a logo + base are present', async () => {
    expect(await renderCompanyLogo(reader(ASSET), 'https://app.example', 'ws')).toContain(`/assets/${ASSET}`);
  });
  it('returns "" when reader/base missing, no logo, or a lookup throws', async () => {
    expect(await renderCompanyLogo(undefined, 'https://app.example', 'ws')).toBe('');
    expect(await renderCompanyLogo(reader(ASSET), undefined, 'ws')).toBe('');
    expect(await renderCompanyLogo(reader(null), 'https://app.example', 'ws')).toBe('');
    expect(await renderCompanyLogo(reader({ throws: true }), 'https://app.example', 'ws')).toBe('');
  });
});
