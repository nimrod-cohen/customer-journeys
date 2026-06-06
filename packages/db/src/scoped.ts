// Workspace-scoped query builder (§3, §8, §13).
//
// Service-role connections bypass Postgres RLS, so the ONLY thing standing
// between a service Lambda and a cross-tenant leak is in-code workspace_id
// scoping. `scopedQuery` makes that scoping mandatory and mechanical: it always
// prepends `workspace_id = $1`, renumbers the caller's placeholders, and refuses
// to build a query at all without a workspaceId.

/** A parameterized query ready for `pool.query(text, values)`. */
export interface ScopedQuery {
  readonly text: string;
  readonly values: unknown[];
}

/**
 * Build a workspace-scoped WHERE query.
 *
 * `fragment` is a SQL string whose placeholders start at `$1` (e.g.
 * `"SELECT * FROM profiles WHERE email = $1"`). The leading clause up to and
 * including the first `WHERE` is preserved; everything after the `WHERE` becomes
 * the scoped condition `workspace_id = $1 AND (<rest>)`. If there is no `WHERE`,
 * one is appended.
 *
 * Throws if `workspaceId` is falsy — the central tenancy guard.
 */
export function scopedQuery(
  workspaceId: string,
  fragment: string,
  params: readonly unknown[] = [],
): ScopedQuery {
  if (!workspaceId) {
    throw new Error('scopedQuery: workspaceId is required (tenant-isolation guard)');
  }

  // Shift every $n placeholder up by one to make room for workspace_id at $1.
  const shifted = fragment.replace(/\$(\d+)/g, (_m, n: string) => `$${Number(n) + 1}`);

  const whereIdx = shifted.search(/\bWHERE\b/i);
  let text: string;
  if (whereIdx === -1) {
    text = `${shifted.trimEnd()} WHERE workspace_id = $1 AND (TRUE)`;
  } else {
    const head = shifted.slice(0, whereIdx);
    const afterWhere = shifted.slice(whereIdx + 5); // length of "WHERE"
    text = `${head}WHERE workspace_id = $1 AND (${afterWhere.trim()})`;
  }

  return { text, values: [workspaceId, ...params] };
}
