import { describe, it, expect } from 'vitest';
import {
  compileWhere,
  validateAst,
  isTimeSensitive,
  resolveField,
  resolveOperator,
  SCALAR_FEATURE_FIELDS,
  SCALAR_PROFILE_FIELDS,
  type AstNode,
} from '../src/compile.js';

// SECURITY-CRITICAL unit suite (§8, CLAUDE.md invariant 6). The compiler is the
// highest-value target: workspace_id ALWAYS $1; every AST value a $n placeholder
// (no literal in text); jsonb KEY names bound as params (field-name injection
// vector); in/not-in bind the array as ONE param; unknown field/operator THROW;
// value injection only ever lands in values[]; deep nested and/or/not exact text.

const WS = 'aaaaaaaa-0000-0000-0000-000000000001';

describe('resolveField (whitelist + jsonb-key binding)', () => {
  it('maps scalar feature columns', () => {
    expect(resolveField('total_events').mapping).toEqual({ kind: 'scalar', column: 'pf.total_events' });
    expect(resolveField('monetary_total').mapping).toEqual({ kind: 'scalar', column: 'pf.monetary_total' });
    expect(resolveField('last_event_at').mapping).toEqual({ kind: 'scalar', column: 'pf.last_event_at' });
    expect(resolveField('last_email_open_at').mapping).toEqual({
      kind: 'scalar',
      column: 'pf.last_email_open_at',
    });
  });

  it('captures the attribute key to bind (never concatenate)', () => {
    const r = resolveField('attributes.country');
    expect(r.mapping.kind).toBe('attribute');
    expect(r.jsonKey).toBe('country');
  });

  it('captures the counter key to bind', () => {
    const r = resolveField('features.counters.purchase_30d');
    expect(r.mapping.kind).toBe('counter');
    expect(r.jsonKey).toBe('purchase_30d');
  });

  it('THROWS on an unknown / non-whitelisted field', () => {
    expect(() => resolveField('profiles.email')).toThrow();
    expect(() => resolveField('password')).toThrow();
    expect(() => resolveField('')).toThrow();
  });

  it('THROWS on an injection attempt in the field NAME', () => {
    expect(() => resolveField("attributes.country'; DROP TABLE profiles;--")).not.toThrow();
    // ^ it does NOT throw because it's a valid attribute path — but the malicious
    // text becomes the BOUND jsonb key, never SQL. Prove that:
    const r = resolveField("attributes.x'; DROP TABLE profiles;--");
    expect(r.jsonKey).toBe("x'; DROP TABLE profiles;--");
    // A field that is neither a scalar col nor a known prefix is rejected outright.
    expect(() => resolveField("evil; DROP TABLE profiles;--")).toThrow();
  });
});

describe('resolveOperator (whitelist)', () => {
  for (const op of ['=', '!=', '>', '>=', '<', '<=', 'in', 'not in', 'exists']) {
    it(`accepts "${op}"`, () => expect(resolveOperator(op)).toBe(op));
  }
  it('THROWS on unknown operators', () => {
    expect(() => resolveOperator('LIKE')).toThrow();
    expect(() => resolveOperator('=; DROP')).toThrow();
    expect(() => resolveOperator('')).toThrow();
  });
});

describe('compileWhere — workspace_id is structurally $1', () => {
  it('binds workspace_id at $1 even for an empty/null AST', () => {
    const q = compileWhere(WS, null);
    expect(q.values[0]).toBe(WS);
    expect(q.text).toBe('p.workspace_id = $1 AND (TRUE)');
  });

  it('THROWS without a workspaceId (tenant-isolation guard)', () => {
    expect(() => compileWhere('', { field: 'total_events', operator: '>', value: 1 })).toThrow();
  });

  it('workspace_id is NEVER derived from the AST (an AST "workspace_id" field is rejected)', () => {
    const ast: AstNode = { field: 'workspace_id', operator: '=', value: 'other-ws' } as AstNode;
    expect(() => compileWhere(WS, ast)).toThrow();
  });
});

describe('compileWhere — exact parameterized SQL for the §8 example AST', () => {
  const ast: AstNode = {
    op: 'and',
    conditions: [
      { field: 'features.counters.purchase_30d', operator: '>=', value: 3 },
      { op: 'not', conditions: [{ field: 'features.counters.open_7d', operator: '>', value: 0 }] },
      { field: 'attributes.country', operator: 'in', value: ['IL', 'US'] },
    ],
  };

  it('produces the exact text + values', () => {
    const q = compileWhere(WS, ast);
    expect(q.text).toBe(
      'p.workspace_id = $1 AND (' +
        '((pf.counters ->> $2)::numeric >= $3 AND ' +
        'NOT ((pf.counters ->> $4)::numeric > $5) AND ' +
        '(p.attributes ->> $6) = ANY($7)))',
    );
    expect(q.values).toEqual([WS, 'purchase_30d', 3, 'open_7d', 0, 'country', ['IL', 'US']]);
  });

  it('every AST value is a $n placeholder — no literal appears in text', () => {
    const q = compileWhere(WS, ast);
    expect(q.text).not.toContain('purchase_30d');
    expect(q.text).not.toContain('open_7d');
    expect(q.text).not.toContain('country');
    expect(q.text).not.toContain('IL');
    expect(q.text).not.toContain('US');
    // the literal value 3 only ever appears as the placeholder token "$3", never
    // as a bare literal operand (e.g. ">= 3").
    expect(q.text).not.toMatch(/>=\s*3\b/);
    expect(q.text).not.toContain(WS);
  });
});

describe('compileWhere — operators render correctly', () => {
  it('in → = ANY($n) with the array bound as ONE param', () => {
    const q = compileWhere(WS, { field: 'attributes.tier', operator: 'in', value: ['gold', 'silver'] });
    expect(q.text).toBe('p.workspace_id = $1 AND ((p.attributes ->> $2) = ANY($3))');
    expect(q.values).toEqual([WS, 'tier', ['gold', 'silver']]);
    // exactly one param for the whole array
    expect(q.values.filter((v) => Array.isArray(v))).toHaveLength(1);
  });

  it('not in → != ALL($n) with the array bound as ONE param', () => {
    const q = compileWhere(WS, { field: 'attributes.tier', operator: 'not in', value: ['banned'] });
    expect(q.text).toBe('p.workspace_id = $1 AND ((p.attributes ->> $2) != ALL($3))');
    expect(q.values).toEqual([WS, 'tier', ['banned']]);
  });

  it('exists → IS NOT NULL (no value param)', () => {
    const q = compileWhere(WS, { field: 'last_email_open_at', operator: 'exists' });
    expect(q.text).toBe('p.workspace_id = $1 AND (pf.last_email_open_at IS NOT NULL)');
    expect(q.values).toEqual([WS]);
  });

  it('scalar comparisons on a scalar feature column', () => {
    const q = compileWhere(WS, { field: 'total_events', operator: '>=', value: 10 });
    expect(q.text).toBe('p.workspace_id = $1 AND (pf.total_events >= $2)');
    expect(q.values).toEqual([WS, 10]);
  });
});

describe('compileWhere — injection in a VALUE only appears in values[]', () => {
  it('keeps a malicious value out of the SQL text', () => {
    const evil = "x' OR '1'='1'; DROP TABLE profiles;--";
    const q = compileWhere(WS, { field: 'attributes.country', operator: '=', value: evil });
    expect(q.text).toBe('p.workspace_id = $1 AND ((p.attributes ->> $2) = $3)');
    expect(q.text).not.toContain('DROP TABLE');
    expect(q.values).toEqual([WS, 'country', evil]);
  });

  it('a malicious jsonb KEY is bound as a param, never concatenated', () => {
    const evilKey = "country'); DROP TABLE profiles;--";
    const q = compileWhere(WS, { field: `attributes.${evilKey}`, operator: '=', value: 'IL' });
    expect(q.text).toBe('p.workspace_id = $1 AND ((p.attributes ->> $2) = $3)');
    expect(q.text).not.toContain('DROP TABLE');
    expect(q.values).toEqual([WS, evilKey, 'IL']);
  });
});

describe('compileWhere — deep nested and/or/not exact text + params', () => {
  it('nests groups with correct precedence and placeholder numbering', () => {
    const ast: AstNode = {
      op: 'or',
      conditions: [
        {
          op: 'and',
          conditions: [
            { field: 'total_events', operator: '>', value: 5 },
            { op: 'not', conditions: [{ field: 'attributes.churned', operator: '=', value: true }] },
          ],
        },
        { field: 'monetary_total', operator: '>=', value: 100 },
      ],
    };
    const q = compileWhere(WS, ast);
    expect(q.text).toBe(
      'p.workspace_id = $1 AND (' +
        '((pf.total_events > $2 AND NOT ((p.attributes ->> $3) = $4)) OR ' +
        'pf.monetary_total >= $5))',
    );
    expect(q.values).toEqual([WS, 5, 'churned', true, 100]);
  });
});

describe('validateAst (shape guard)', () => {
  it('rejects an unknown group op', () => {
    expect(() => validateAst({ op: 'xor', conditions: [] } as unknown as AstNode)).toThrow();
  });
  it('rejects an empty group', () => {
    expect(() => validateAst({ op: 'and', conditions: [] })).toThrow();
  });
  it('rejects a "not" with more than one child', () => {
    expect(() =>
      validateAst({
        op: 'not',
        conditions: [
          { field: 'total_events', operator: '>', value: 1 },
          { field: 'total_events', operator: '<', value: 9 },
        ],
      }),
    ).toThrow();
  });
  it('rejects a leaf missing field/operator', () => {
    expect(() => validateAst({ field: '', operator: '=' } as unknown as AstNode)).toThrow();
  });
});

describe('profile scalar fields (email_status etc.) — deliverability state', () => {
  it('maps email_status to the profiles column', () => {
    expect(resolveField('email_status').mapping).toEqual({ kind: 'scalar', column: 'p.email_status' });
  });

  it('compiles email_status = bounced as a parameterized predicate', () => {
    const q = compileWhere(WS, { field: 'email_status', operator: '=', value: 'bounced' });
    expect(q.text).toBe('p.workspace_id = $1 AND (p.email_status = $2)');
    expect(q.values).toEqual([WS, 'bounced']);
    expect(q.text).not.toContain('bounced');
  });
});

describe('event predicates — "people who did an event"', () => {
  it('occurred (no count) → workspace-scoped EXISTS over events', () => {
    const q = compileWhere(WS, { event: 'purchase' } as AstNode);
    expect(q.text).toBe(
      'p.workspace_id = $1 AND (EXISTS (SELECT 1 FROM events e WHERE ' +
        'e.workspace_id = $1 AND e.profile_id = p.id AND e.type = $2))',
    );
    expect(q.values).toEqual([WS, 'purchase']);
    // The event type is a bound param, never concatenated.
    expect(q.text).not.toContain('purchase');
  });

  it('count test → (SELECT count(*) …) <op> $n', () => {
    const q = compileWhere(WS, { event: 'purchase', operator: '>=', value: 2 } as AstNode);
    expect(q.text).toBe(
      'p.workspace_id = $1 AND ((SELECT count(*) FROM events e WHERE ' +
        'e.workspace_id = $1 AND e.profile_id = p.id AND e.type = $2) >= $3)',
    );
    expect(q.values).toEqual([WS, 'purchase', 2]);
  });

  it('payload conditions (event attributes) bind key + value as params', () => {
    const q = compileWhere(WS, {
      event: 'lead',
      where: [{ field: 'payload.interest', operator: '=', value: 'strategies-webinar' }],
    } as AstNode);
    expect(q.text).toBe(
      'p.workspace_id = $1 AND (EXISTS (SELECT 1 FROM events e WHERE ' +
        'e.workspace_id = $1 AND e.profile_id = p.id AND e.type = $2 AND (e.payload ->> $3) = $4))',
    );
    expect(q.values).toEqual([WS, 'lead', 'interest', 'strategies-webinar']);
    expect(q.text).not.toContain('strategies-webinar');
    expect(q.text).not.toContain('interest');
  });

  it('workspace_id is bound at $1 INSIDE the subquery (no cross-tenant events)', () => {
    const q = compileWhere(WS, { event: 'x' } as AstNode);
    // Two references to $1: the outer profile scope and the inner events scope.
    expect(q.text.match(/e\.workspace_id = \$1/g)).toHaveLength(1);
    expect(q.values[0]).toBe(WS);
  });

  it('an event payload field NOT prefixed payload.* is rejected', () => {
    expect(() =>
      validateAst({ event: 'x', where: [{ field: 'attributes.k', operator: '=', value: 1 }] } as AstNode),
    ).toThrow();
  });

  it('an invalid event count operator is rejected', () => {
    expect(() =>
      validateAst({ event: 'x', operator: 'LIKE', value: 1 } as unknown as AstNode),
    ).toThrow();
  });

  it('combines with field conditions in a group', () => {
    const q = compileWhere(WS, {
      op: 'and',
      conditions: [
        { field: 'email_status', operator: '=', value: 'active' },
        { event: 'purchase', operator: '>=', value: 1 },
      ],
    } as AstNode);
    expect(q.text).toBe(
      'p.workspace_id = $1 AND (' +
        '(p.email_status = $2 AND ' +
        '(SELECT count(*) FROM events e WHERE e.workspace_id = $1 AND e.profile_id = p.id AND e.type = $3) >= $4))',
    );
    expect(q.values).toEqual([WS, 'active', 'purchase', 1]);
  });
});

describe('event time-window + negate (§ time-sensitive rules)', () => {
  it('occurred within last N days → adds a sliding occurred_at window (days bound as a param)', () => {
    const q = compileWhere(WS, { event: 'purchase', withinDays: 30 } as AstNode);
    expect(q.text).toBe(
      'p.workspace_id = $1 AND (EXISTS (SELECT 1 FROM events e WHERE ' +
        "e.workspace_id = $1 AND e.profile_id = p.id AND e.type = $2 " +
        "AND e.occurred_at >= now() - ($3::numeric * interval '1 day')))",
    );
    expect(q.values).toEqual([WS, 'purchase', 30]);
    // The day count is a bound param, never concatenated.
    expect(q.text).not.toMatch(/\b30\b/);
  });

  it('did NOT occur (negate, no count) → NOT EXISTS', () => {
    const q = compileWhere(WS, { event: 'purchase', negate: true } as AstNode);
    expect(q.text).toBe(
      'p.workspace_id = $1 AND (NOT (EXISTS (SELECT 1 FROM events e WHERE ' +
        'e.workspace_id = $1 AND e.profile_id = p.id AND e.type = $2)))',
    );
    expect(q.values).toEqual([WS, 'purchase']);
  });

  it('did NOT occur within last N days → NOT EXISTS over the window', () => {
    const q = compileWhere(WS, { event: 'login', negate: true, withinDays: 7 } as AstNode);
    expect(q.text).toBe(
      'p.workspace_id = $1 AND (NOT (EXISTS (SELECT 1 FROM events e WHERE ' +
        "e.workspace_id = $1 AND e.profile_id = p.id AND e.type = $2 " +
        "AND e.occurred_at >= now() - ($3::numeric * interval '1 day'))))",
    );
    expect(q.values).toEqual([WS, 'login', 7]);
  });

  it('count threshold scoped by the window: ">= 3 times within 30 days"', () => {
    const q = compileWhere(WS, { event: 'purchase', operator: '>=', value: 3, withinDays: 30 } as AstNode);
    expect(q.text).toBe(
      'p.workspace_id = $1 AND ((SELECT count(*) FROM events e WHERE ' +
        "e.workspace_id = $1 AND e.profile_id = p.id AND e.type = $2 " +
        "AND e.occurred_at >= now() - ($3::numeric * interval '1 day')) >= $4)",
    );
    expect(q.values).toEqual([WS, 'purchase', 30, 3]);
  });

  it('rejects a non-positive withinDays', () => {
    expect(() => validateAst({ event: 'x', withinDays: 0 } as AstNode)).toThrow(/withinDays/i);
    expect(() => validateAst({ event: 'x', withinDays: -5 } as AstNode)).toThrow(/withinDays/i);
  });
});

describe('isTimeSensitive (which segments need the scheduled sweep)', () => {
  it('true when any event predicate has a withinDays window (even nested)', () => {
    expect(isTimeSensitive({ event: 'login', withinDays: 7 } as AstNode)).toBe(true);
    expect(
      isTimeSensitive({
        op: 'and',
        conditions: [
          { field: 'attributes.tier', operator: '=', value: 'vip' },
          { op: 'or', conditions: [{ event: 'purchase', withinDays: 30 }, { event: 'login' }] },
        ],
      } as AstNode),
    ).toBe(true);
  });

  it('false for ever-events and pure attribute/count rules', () => {
    expect(isTimeSensitive(null)).toBe(false);
    expect(isTimeSensitive({ field: 'attributes.tier', operator: '=', value: 'vip' } as AstNode)).toBe(false);
    expect(isTimeSensitive({ event: 'purchase', operator: '>=', value: 2 } as AstNode)).toBe(false);
    expect(isTimeSensitive({ op: 'and', conditions: [{ event: 'login' }] } as AstNode)).toBe(false);
  });
});

describe('SCALAR_PROFILE_FIELDS export', () => {
  it('includes email_status mapped to p.email_status', () => {
    expect(SCALAR_PROFILE_FIELDS.email_status).toBe('p.email_status');
  });
});

describe('SCALAR_FEATURE_FIELDS export is the documented whitelist', () => {
  it('contains exactly the four scalar feature columns', () => {
    expect(Object.keys(SCALAR_FEATURE_FIELDS).sort()).toEqual(
      ['last_email_open_at', 'last_event_at', 'monetary_total', 'total_events'].sort(),
    );
  });
});
