// Email-template persistence helpers (§11, §6 `email_templates`).
//
// The editor emits MJML; the save path compiles it to HTML (compileMjml) then
// stores BOTH the source MJML and the compiled HTML in `email_templates`, keyed
// per workspace. `buildTemplateUpsert` is a pure, parameterized SqlStatement —
// workspace_id is always bound at $1, never interpolated (§13). An upsert on
// (workspace_id, name) keeps a named template a single editable row.

/** A parameterized query ready for `pool.query(text, values)` (shared shape). */
export interface SqlStatement {
  readonly text: string;
  readonly values: unknown[];
}

/**
 * Build the upsert that persists a compiled template for a workspace.
 *
 * Stores `mjml` (source) and `compiled_html` (cross-client output) together so a
 * later edit recompiles from source. Tenancy: workspace_id is bound at $1 and the
 * UPDATE/INSERT both constrain on it — a save can never touch another workspace's
 * template, even one sharing the same `name`.
 *
 * The §6 schema keys `email_templates` on `id` with no natural unique
 * (workspace_id, name) constraint, so a plain `ON CONFLICT` is unavailable
 * without DDL (out of scope). Instead this is a single statement: a CTE UPDATEs
 * the existing (workspace_id, name) row in place, and the trailing INSERT runs
 * only when that UPDATE matched nothing — so a repeated save of the same name is
 * idempotent (one row, updated) rather than duplicating it.
 */
export function buildTemplateUpsert(
  workspaceId: string,
  name: string,
  mjml: string,
  compiledHtml: string,
): SqlStatement {
  if (!workspaceId) {
    throw new Error('buildTemplateUpsert: workspaceId is required (tenant-isolation guard)');
  }
  if (!name) {
    throw new Error('buildTemplateUpsert: name is required');
  }
  return {
    text: `WITH upd AS (
             UPDATE email_templates
             SET mjml = $3, compiled_html = $4, updated_at = now()
             WHERE workspace_id = $1 AND name = $2
             RETURNING id
           )
           INSERT INTO email_templates (workspace_id, name, mjml, compiled_html, updated_at)
           SELECT $1, $2, $3, $4, now()
           WHERE NOT EXISTS (SELECT 1 FROM upd)`,
    values: [workspaceId, name, mjml, compiledHtml],
  };
}
