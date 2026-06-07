// Save-template path (§11). The editor EMITS MJML; the SERVER compiles it to
// cross-client HTML (compileMjml) and stores BOTH the MJML source and compiled
// HTML in email_templates, keyed per workspace (buildTemplateUpsert binds
// workspace_id at $1). This is the single server-side place MJML becomes HTML —
// the client never hand-rolls email HTML. Pure orchestration over injected I/O.
import { compileMjml, buildTemplateUpsert, type SqlStatement } from '@cdp/email';

/** What a save needs: workspace from context, plus the editor's {name, mjml}. */
export interface SaveTemplateInput {
  readonly workspaceId: string;
  readonly name: string;
  readonly mjml: string;
}

/** The compiled artifacts persisted (returned for assertions/responses). */
export interface SaveTemplateResult {
  readonly mjml: string;
  readonly compiledHtml: string;
  readonly statement: SqlStatement;
}

/** Run one workspace-scoped statement (workspace_id bound at $1). */
export type RunStatement = (stmt: SqlStatement) => Promise<void>;

/**
 * Compile the MJML server-side then persist (mjml + compiled_html) via the
 * workspace-scoped upsert. workspace_id comes from the caller's context, never a
 * client body (§13). Throws (via compileMjml) on invalid MJML so broken email
 * HTML is never stored.
 */
export async function saveTemplate(
  run: RunStatement,
  input: SaveTemplateInput,
): Promise<SaveTemplateResult> {
  if (!input.workspaceId) {
    throw new Error('saveTemplate: workspaceId is required (tenant-isolation guard)');
  }
  const compiledHtml = compileMjml(input.mjml);
  const statement = buildTemplateUpsert(
    input.workspaceId,
    input.name,
    input.mjml,
    compiledHtml,
  );
  await run(statement);
  return { mjml: input.mjml, compiledHtml, statement };
}
