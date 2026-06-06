import { describe, it, expect } from 'vitest';
import {
  compileWhere,
  validateAst,
  resolveField,
  resolveOperator,
  SCALAR_FEATURE_FIELDS,
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

describe('SCALAR_FEATURE_FIELDS export is the documented whitelist', () => {
  it('contains exactly the four scalar feature columns', () => {
    expect(Object.keys(SCALAR_FEATURE_FIELDS).sort()).toEqual(
      ['last_email_open_at', 'last_event_at', 'monetary_total', 'total_events'].sort(),
    );
  });
});
