import { describe, it, expect } from 'vitest';
import { scopedQuery } from '../src/scoped.js';

// AC1 in-code scoping (§3, §13): service-role code bypasses RLS, so it MUST
// scope by workspace_id in code. scopedQuery ALWAYS prepends `workspace_id = $n`
// and refuses to build a query without a workspaceId. This is a pure unit test
// of the SQL/param assembly; the DB-backed proof is the integration test.

describe('scopedQuery(workspaceId, fragment, params)', () => {
  it('prepends workspace_id as $1 and shifts caller params', () => {
    const q = scopedQuery('ws-1', 'SELECT * FROM profiles WHERE email = $1', ['a@b.com']);
    expect(q.text).toBe(
      'SELECT * FROM profiles WHERE workspace_id = $1 AND (email = $2)',
    );
    expect(q.values).toEqual(['ws-1', 'a@b.com']);
  });

  it('handles multiple params, renumbering them after the workspace param', () => {
    const q = scopedQuery(
      'ws-1',
      'SELECT * FROM events WHERE type = $1 AND occurred_at > $2',
      ['purchase', '2026-01-01'],
    );
    expect(q.text).toBe(
      'SELECT * FROM events WHERE workspace_id = $1 AND (type = $2 AND occurred_at > $3)',
    );
    expect(q.values).toEqual(['ws-1', 'purchase', '2026-01-01']);
  });

  it('works with a fragment that has no params', () => {
    const q = scopedQuery('ws-9', 'SELECT count(*) FROM profiles');
    expect(q.text).toBe('SELECT count(*) FROM profiles WHERE workspace_id = $1 AND (TRUE)');
    expect(q.values).toEqual(['ws-9']);
  });

  it('THROWS when workspaceId is missing — the core tenancy guard', () => {
    expect(() => scopedQuery('', 'SELECT 1', [])).toThrow(/workspace/i);
    // @ts-expect-error testing the runtime guard against undefined
    expect(() => scopedQuery(undefined, 'SELECT 1', [])).toThrow(/workspace/i);
  });

  it('does not renumber placeholders inside string literals naively (uses explicit fragment params)', () => {
    // Caller is responsible for parameterizing; scopedQuery only shifts $n tokens.
    const q = scopedQuery('ws-1', 'UPDATE profiles SET email_status = $1 WHERE id = $2', [
      'bounced',
      'p-1',
    ]);
    expect(q.values).toEqual(['ws-1', 'bounced', 'p-1']);
    expect(q.text).toContain('workspace_id = $1');
    expect(q.text).toContain('email_status = $2');
    expect(q.text).toContain('id = $3');
  });
});
