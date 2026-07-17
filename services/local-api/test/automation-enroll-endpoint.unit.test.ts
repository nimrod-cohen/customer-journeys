// Phase 3 (unit): the manual-enroll handler input contract — exactly one of
// profile_id | segment_id is required; bad input is rejected (400) BEFORE any DB
// write. Also asserts the route is registered as manage_content.
import { describe, it, expect } from 'vitest';
import { enrollIntoAutomation } from '../src/handlers.js';
import { ROUTE_TABLE } from '../src/routes.js';
import type { WorkspaceContext } from '@cdp/shared';

const ctx = { workspaceId: 'ws-1', userId: 'u-1', isPlatformAdmin: false } as unknown as WorkspaceContext;
// A pool that THROWS if any query runs — proves bad input is rejected before any DB op.
const noDbPool = {
  query: () => {
    throw new Error('no DB query should run for invalid input');
  },
  connect: () => {
    throw new Error('no DB connect should run for invalid input');
  },
} as never;
const req = (body: unknown) => ({ params: { id: 'camp-1' }, query: {}, body });
const deps = {} as never;

describe('enrollIntoAutomation input contract', () => {
  it('400 when neither profile_id nor segment_id is supplied', async () => {
    const r = await enrollIntoAutomation(ctx, noDbPool, req({}), deps);
    expect(r.status).toBe(400);
  });

  it('400 when BOTH profile_id and segment_id are supplied (ambiguous)', async () => {
    const r = await enrollIntoAutomation(ctx, noDbPool, req({ profile_id: 'p', segment_id: 's' }), deps);
    expect(r.status).toBe(400);
  });

  it('400 on a blank/non-string profile_id', async () => {
    expect((await enrollIntoAutomation(ctx, noDbPool, req({ profile_id: '   ' }), deps)).status).toBe(400);
    expect((await enrollIntoAutomation(ctx, noDbPool, req({ profile_id: 123 }), deps)).status).toBe(400);
  });

  it('400 on a blank/non-string segment_id', async () => {
    expect((await enrollIntoAutomation(ctx, noDbPool, req({ segment_id: '' }), deps)).status).toBe(400);
    expect((await enrollIntoAutomation(ctx, noDbPool, req({ segment_id: {} }), deps)).status).toBe(400);
  });

  it('the route is registered as manage_content', () => {
    expect(ROUTE_TABLE['POST /automations/:id/enroll']).toBe('manage_content');
  });

  it('the handler returns a Promise (kit Button auto-lock contract)', () => {
    const out = enrollIntoAutomation(ctx, noDbPool, req({}), deps);
    expect(typeof out.then).toBe('function');
    return out; // settle it
  });
});
