// Unit tests for the pure /health probe (§16). No DB, no HTTP — buildHealth is
// driven purely through injected deps, asserting the 200/503 contract.
import { describe, it, expect, vi } from 'vitest';
import { buildHealth } from './health.js';

describe('buildHealth', () => {
  it('200 when the DB ping succeeds and no DLQ probe is configured', async () => {
    const r = await buildHealth({ pingDb: vi.fn(async () => {}) });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.checks).toEqual([{ name: 'database', ok: true }]);
  });

  it('503 when the DB ping fails (the hard gate)', async () => {
    const r = await buildHealth({
      pingDb: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    });
    expect(r.status).toBe(503);
    expect(r.body.ok).toBe(false);
    expect(r.body.checks[0]).toMatchObject({ name: 'database', ok: false, detail: 'connection refused' });
  });

  it('200 when DB is up and all DLQs are empty', async () => {
    const r = await buildHealth({
      pingDb: vi.fn(async () => {}),
      dlqDepths: vi.fn(async () => ({ ingest: 0, dispatch: 0 })),
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.checks).toEqual([
      { name: 'database', ok: true },
      { name: 'dlq:ingest', ok: true },
      { name: 'dlq:dispatch', ok: true },
    ]);
  });

  it('503 degraded when any DLQ has depth > 0 (operator attention, §16)', async () => {
    const r = await buildHealth({
      pingDb: vi.fn(async () => {}),
      dlqDepths: vi.fn(async () => ({ ingest: 0, dispatch: 3 })),
    });
    expect(r.status).toBe(503);
    expect(r.body.ok).toBe(false);
    const dispatch = r.body.checks.find((c) => c.name === 'dlq:dispatch');
    expect(dispatch).toMatchObject({ ok: false, detail: '3 message(s) in DLQ' });
  });

  it('503 when the DLQ probe itself throws (treated as a failed check)', async () => {
    const r = await buildHealth({
      pingDb: vi.fn(async () => {}),
      dlqDepths: vi.fn(async () => {
        throw new Error('sqs unreachable');
      }),
    });
    expect(r.status).toBe(503);
    expect(r.body.checks.find((c) => c.name === 'dlq')).toMatchObject({ ok: false });
  });
});
