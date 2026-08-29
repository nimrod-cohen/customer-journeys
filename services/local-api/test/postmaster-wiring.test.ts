import { describe, it, expect } from 'vitest';
import {
  makeRefreshTokenSource,
  postmasterFromEnv,
  syncDomainWithPostmaster,
  makePostmasterClient,
  type PostmasterHttp,
  type PostmasterClient,
} from '../src/postmaster.js';

describe('makeRefreshTokenSource', () => {
  function fakeToken(expiresIn = 3600) {
    let calls = 0;
    const http: PostmasterHttp = {
      async request() {
        calls += 1;
        return { status: 200, body: JSON.stringify({ access_token: `tok-${calls}`, expires_in: expiresIn }) };
      },
    };
    return {
      count: () => calls,
      src: makeRefreshTokenSource({ clientId: 'i', clientSecret: 's', refreshToken: 'r' }, http),
    };
  }

  it('mints an access token from the refresh token', async () => {
    const f = fakeToken();
    expect(await f.src.accessToken()).toBe('tok-1');
  });

  // Minting per call would burn quota and add a round trip to every request.
  it('caches until shortly before expiry', async () => {
    const f = fakeToken();
    await f.src.accessToken();
    await f.src.accessToken();
    await f.src.accessToken();
    expect(f.count()).toBe(1);
  });

  // A token that expires mid-flight is worse than one refresh too many.
  it('refreshes again when the cached token is about to expire', async () => {
    const f = fakeToken(30); // 30s - 60s margin => already stale
    await f.src.accessToken();
    await f.src.accessToken();
    expect(f.count()).toBe(2);
  });

  it('throws when Google rejects the refresh token', async () => {
    const http: PostmasterHttp = {
      async request() {
        return { status: 400, body: '{"error":"invalid_grant"}' };
      },
    };
    const src = makeRefreshTokenSource({ clientId: 'i', clientSecret: 's', refreshToken: 'bad' }, http);
    await expect(src.accessToken()).rejects.toThrow(/token refresh failed/);
  });
});

describe('postmasterFromEnv', () => {
  const full = {
    GOOGLE_POSTMASTER_CLIENT_ID: 'i',
    GOOGLE_POSTMASTER_CLIENT_SECRET: 's',
    GOOGLE_POSTMASTER_REFRESH_TOKEN: 'r',
  };

  it('builds a client when every secret is present', () => {
    expect(postmasterFromEnv(full as NodeJS.ProcessEnv)).not.toBeNull();
  });

  // Absence is a NORMAL state — reputation monitoring is optional, so callers must
  // work without it rather than treating this as a failure.
  it('returns null when any secret is missing', () => {
    expect(postmasterFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    for (const k of Object.keys(full)) {
      const partial = { ...full } as Record<string, string>;
      delete partial[k];
      expect(postmasterFromEnv(partial as NodeJS.ProcessEnv)).toBeNull();
    }
  });
});

function clientWith(routes: Record<string, { status: number; body: string }>): PostmasterClient {
  const http: PostmasterHttp = {
    async request(method, url) {
      const key = `${method} ${url.replace('https://gmailpostmastertools.googleapis.com/v2', '')}`;
      return routes[key] ?? { status: 500, body: '{}' };
    },
  };
  return makePostmasterClient({ accessToken: async () => 't' }, http);
}

describe('syncDomainWithPostmaster', () => {
  it('registers, fetches the token, and reports verification', async () => {
    const c = clientWith({
      'POST /domains': { status: 200, body: '{"name":"domains/acme.com"}' },
      'GET /domains/acme.com/verificationToken': { status: 200, body: '{"token":"google-site-verification=xyz"}' },
      'POST /domains/acme.com:verify': { status: 200, body: '{"verified":true}' },
    });
    expect(await syncDomainWithPostmaster(c, 'acme.com')).toEqual({
      token: 'google-site-verification=xyz',
      verified: true,
      error: null,
    });
  });

  it('returns the token but unverified while DNS is still propagating', async () => {
    const c = clientWith({
      'POST /domains': { status: 200, body: '{}' },
      'GET /domains/acme.com/verificationToken': { status: 200, body: '{"token":"tok"}' },
      'POST /domains/acme.com:verify': { status: 404, body: '{}' },
    });
    const r = await syncDomainWithPostmaster(c, 'acme.com');
    expect(r.token).toBe('tok');
    expect(r.verified).toBe(false);
    expect(r.error).toBeNull(); // not-yet is normal, not an error
  });

  // Reputation visibility must never be able to break domain setup.
  it('never throws when Google is unavailable', async () => {
    const c = clientWith({}); // every route 500s
    const r = await syncDomainWithPostmaster(c, 'acme.com');
    expect(r.verified).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('still verifies when the token endpoint fails but verify succeeds', async () => {
    const c = clientWith({
      'POST /domains': { status: 200, body: '{}' },
      'GET /domains/acme.com/verificationToken': { status: 500, body: '' },
      'POST /domains/acme.com:verify': { status: 200, body: '{"verified":true}' },
    });
    const r = await syncDomainWithPostmaster(c, 'acme.com');
    expect(r.token).toBeNull();
    expect(r.verified).toBe(true);
  });

  it('is idempotent for an already-registered domain', async () => {
    const c = clientWith({
      'POST /domains': { status: 409, body: '{"error":"exists"}' },
      'GET /domains/acme.com/verificationToken': { status: 200, body: '{"token":"tok"}' },
      'POST /domains/acme.com:verify': { status: 200, body: '{"verified":true}' },
    });
    expect((await syncDomainWithPostmaster(c, 'acme.com')).verified).toBe(true);
  });
});

describe('HTTP timeout', () => {
  // Google is called from the user-facing domain-check path; a hang there would
  // mean reputation monitoring blocking domain setup, which is the exact coupling
  // this module exists to avoid.
  it('aborts a request that exceeds the timeout', async () => {
    const { fetchPostmasterHttp } = await import('../src/postmaster.js');
    const original = globalThis.fetch;
    globalThis.fetch = ((_u: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    try {
      const http = fetchPostmasterHttp(30);
      await expect(http.request('GET', 'https://example.test', {})).rejects.toThrow(/abort/i);
    } finally {
      globalThis.fetch = original;
    }
  });
});
