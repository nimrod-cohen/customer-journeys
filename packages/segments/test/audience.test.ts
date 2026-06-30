import { describe, it, expect } from 'vitest';
import {
  collectAudienceSegmentIds,
  inlineDynamicSegments,
  type AudienceSegmentDef,
} from '../src/audience.js';
import { compileWhere, type AstNode } from '../src/compile.js';

const defs = (m: Record<string, AudienceSegmentDef>): Map<string, AudienceSegmentDef> => new Map(Object.entries(m));

describe('collectAudienceSegmentIds', () => {
  it('collects every referenced segment id (deduped), through nested groups', () => {
    const ast: AstNode = {
      op: 'or',
      conditions: [
        { segment: 'seg-a' },
        { op: 'and', conditions: [{ segment: 'seg-b', negate: true }, { field: 'attributes.tier', operator: '=', value: 'gold' }, { segment: 'seg-a' }] },
      ],
    };
    expect(collectAudienceSegmentIds(ast).sort()).toEqual(['seg-a', 'seg-b']);
  });
  it('returns [] for a null AST or an AST with no segment leaves', () => {
    expect(collectAudienceSegmentIds(null)).toEqual([]);
    expect(collectAudienceSegmentIds({ field: 'attributes.tier', operator: '=', value: 'gold' })).toEqual([]);
  });
});

describe('inlineDynamicSegments', () => {
  it('inlines a DYNAMIC segment LIVE (its rule replaces the membership leaf)', () => {
    const ast: AstNode = { segment: 'dyn' };
    const out = inlineDynamicSegments(ast, defs({ dyn: { kind: 'dynamic_realtime', definition: { field: 'attributes.tier', operator: '=', value: 'gold' } } }));
    expect(out).toEqual({ field: 'attributes.tier', operator: '=', value: 'gold' });
    // compiles to the rule, NOT a segment_memberships EXISTS.
    expect(compileWhere('ws', out).text).not.toMatch(/segment_memberships/);
  });

  it('keeps a MANUAL segment as a membership EXISTS', () => {
    const ast: AstNode = { segment: 'man' };
    const out = inlineDynamicSegments(ast, defs({ man: { kind: 'manual', definition: null } }));
    expect(out).toEqual({ segment: 'man' }); // unchanged
    expect(compileWhere('ws', out).text).toMatch(/segment_memberships/);
  });

  it('negate on a DYNAMIC segment wraps the inlined rule in a NOT group', () => {
    const ast: AstNode = { segment: 'dyn', negate: true };
    const out = inlineDynamicSegments(ast, defs({ dyn: { kind: 'dynamic_realtime', definition: { field: 'attributes.tier', operator: '=', value: 'gold' } } }));
    expect(out).toEqual({ op: 'not', conditions: [{ field: 'attributes.tier', operator: '=', value: 'gold' }] });
  });

  it('a DYNAMIC segment with a NULL definition matches NOBODY (const false); negated → everybody', () => {
    expect(inlineDynamicSegments({ segment: 'd' }, defs({ d: { kind: 'dynamic_realtime', definition: null } }))).toEqual({ const: false });
    expect(inlineDynamicSegments({ segment: 'd', negate: true }, defs({ d: { kind: 'dynamic_realtime', definition: null } }))).toEqual({
      op: 'not',
      conditions: [{ const: false }],
    });
  });

  it('an UNKNOWN (not-loaded) segment is left as a membership EXISTS (safe fallback)', () => {
    const out = inlineDynamicSegments({ segment: 'gone' }, defs({}));
    expect(out).toEqual({ segment: 'gone' });
  });

  it('rewrites SegmentNodes ANYWHERE in the tree, leaving non-segment leaves untouched', () => {
    const ast: AstNode = {
      op: 'and',
      conditions: [
        { field: 'attributes.tier', operator: '=', value: 'gold' },
        { segment: 'dyn' },
        { segment: 'man', negate: true },
        { op: 'or', conditions: [{ segment: 'dyn' }, { event: 'opened', withinDays: 30 }] },
      ],
    };
    const out = inlineDynamicSegments(ast, defs({
      dyn: { kind: 'dynamic_realtime', definition: { field: 'attributes.plan', operator: '=', value: 'pro' } },
      man: { kind: 'manual', definition: null },
    })) as { conditions: AstNode[] };
    expect(out.conditions[0]).toEqual({ field: 'attributes.tier', operator: '=', value: 'gold' });
    expect(out.conditions[1]).toEqual({ field: 'attributes.plan', operator: '=', value: 'pro' }); // dyn inlined
    expect(out.conditions[2]).toEqual({ segment: 'man', negate: true }); // manual kept
    expect((out.conditions[3] as { conditions: AstNode[] }).conditions[0]).toEqual({ field: 'attributes.plan', operator: '=', value: 'pro' });
    // The whole thing still compiles with workspace_id = $1 prepended (inv. 6).
    expect(compileWhere('ws-1', out).text).toMatch(/^p\.workspace_id = \$1 AND/);
  });

  it('does NOT recurse INTO an inlined definition (nested SegmentNodes stay membership-based)', () => {
    // dyn's definition itself references another segment → that nested leaf stays a membership EXISTS.
    const out = inlineDynamicSegments({ segment: 'dyn' }, defs({
      dyn: { kind: 'dynamic_realtime', definition: { op: 'and', conditions: [{ segment: 'nested' }] } },
    }));
    expect(out).toEqual({ op: 'and', conditions: [{ segment: 'nested' }] });
    expect(compileWhere('ws', out).text).toMatch(/segment_memberships/);
  });

  it('passes a null AST through unchanged', () => {
    expect(inlineDynamicSegments(null, defs({}))).toBeNull();
  });
});
