// The seeded DEV_USERS fixture (public creds in the source) must be INERT in
// production — otherwise anyone could sign in as admin@journeys.dev. devLogin +
// registerOwner both gate on devAuthEnabled(). This unit-tests that gate directly
// (synchronous env toggle — no cross-file race); the full "dev-login rejected in
// prod, real user still works" behavior is verified end-to-end against the
// deployed prod app.
import { describe, it, expect } from 'vitest';
import { devAuthEnabled } from '../src/session.js';

describe('devAuthEnabled — dev-login fixture gate', () => {
  it('is disabled in production and enabled everywhere else', () => {
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(devAuthEnabled()).toBe(false);
      process.env.NODE_ENV = 'test';
      expect(devAuthEnabled()).toBe(true);
      process.env.NODE_ENV = 'development';
      expect(devAuthEnabled()).toBe(true);
      delete process.env.NODE_ENV;
      expect(devAuthEnabled()).toBe(true);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
