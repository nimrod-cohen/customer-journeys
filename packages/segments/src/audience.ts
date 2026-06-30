// Broadcast/campaign AUDIENCE composition (§9A). A broadcast audience is a §8 rule AST
// (the SAME shape as a segment definition): profile-attribute + event conditions AND
// segment-membership leaves ("is / is NOT a member of segment X"), combined with AND/OR
// groups. It compiles via `compileWhere` (workspace_id = $1 always prepended) exactly like
// a segment — so tenant isolation is inherited for free.
//
// The only audience-specific concern is FRESHNESS of referenced segments: a SegmentNode
// compiles to an `EXISTS (segment_memberships …)` (the LAST MATERIALIZED membership). To
// match the existing single-segment broadcast behavior (services/broadcast/src/send.ts,
// which recompiles a DYNAMIC segment's rule LIVE at send), `inlineDynamicSegments` rewrites
// the audience so DYNAMIC referenced segments resolve LIVE (their rule inlined) while MANUAL
// ones keep the membership lookup. The rewrite is PURE and one-level (nested SegmentNodes
// inside an inlined definition stay membership-based — avoids reference cycles).

import type { AstNode, GroupNode, SegmentNode } from './compile.js';

/** The minimal segment shape the audience resolver needs (as read from the DB). */
export interface AudienceSegmentDef {
  readonly kind: string; // 'manual' | 'dynamic_realtime' | 'dynamic_batch'
  readonly definition: AstNode | null;
}

const isSeg = (n: AstNode): n is SegmentNode => typeof (n as SegmentNode).segment === 'string';
const isGroup = (n: AstNode): n is GroupNode =>
  Array.isArray((n as GroupNode).conditions) && typeof (n as GroupNode).op === 'string';

/**
 * Every segment id referenced by a SegmentNode anywhere in the audience AST (deduped).
 * The caller loads these segments' {kind, definition} to validate ownership (inv. 2) and
 * to feed `inlineDynamicSegments`.
 */
export function collectAudienceSegmentIds(ast: AstNode | null | undefined): string[] {
  const out = new Set<string>();
  const walk = (n: AstNode): void => {
    if (isSeg(n)) {
      if (n.segment) out.add(n.segment);
      return;
    }
    if (isGroup(n)) for (const c of n.conditions) walk(c);
  };
  if (ast) walk(ast);
  return [...out];
}

/**
 * Rewrite the audience AST so DYNAMIC referenced segments resolve LIVE (their rule inlined)
 * and MANUAL ones keep the compiler's `EXISTS (segment_memberships …)` lookup. PURE.
 *   - A SegmentNode for a MANUAL (or unknown / not-loaded) segment is left as-is → membership.
 *   - A SegmentNode for a DYNAMIC segment is replaced by that segment's definition AST
 *     (negate → wrapped in a `not` group). A DYNAMIC segment with a NULL definition (an
 *     inactive draft) matches NOBODY (`{const:false}`), negated → everybody — mirroring the
 *     existing send path (a null-definition dynamic segment yields an empty audience, never
 *     blast-all).
 *   - Only TOP-LEVEL SegmentNodes are inlined; SegmentNodes nested inside an inlined
 *     definition stay membership-based (one level — avoids reference cycles).
 */
export function inlineDynamicSegments(
  ast: AstNode | null,
  defs: ReadonlyMap<string, AudienceSegmentDef>,
): AstNode | null {
  if (ast === null || ast === undefined) return ast;
  const rewrite = (n: AstNode): AstNode => {
    if (isSeg(n)) {
      const def = defs.get(n.segment);
      if (!def || def.kind === 'manual') return n; // membership EXISTS (manual / unknown)
      const inner: AstNode = def.definition ?? { const: false };
      return n.negate ? { op: 'not', conditions: [inner] } : inner;
    }
    if (isGroup(n)) return { ...n, conditions: n.conditions.map(rewrite) };
    return n;
  };
  return rewrite(ast);
}
