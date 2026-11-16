// Saved email components (a footer, a header…) shared by many emails. An email
// links to a component and carries a snapshot of its rows; saving the component
// refreshes that snapshot in EVERY email linking to it and recompiles each one,
// in one transaction, so a footer edit reaches scheduled broadcasts, automations
// and transactional messages alike. Workspace-scoped throughout (inv.1/inv.2).
import type { Pool, PoolClient } from 'pg';
import {
  cloneRowsWithFreshIds,
  componentIdsIn,
  designToMjml,
  expandComponents,
  isEmailDesign,
  refreshComponents,
  type ComponentContent,
  type EmailDesign,
} from '@cdp/shared/email-design';
import type { Handler, HandlerResponse } from './handlers.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ok = (body: unknown, status = 200): HandlerResponse => ({ status, body });
type Db = Pool | PoolClient;

/** Load the current content of the given components (workspace-scoped). */
async function loadComponents(db: Db, workspaceId: string, ids: readonly string[]): Promise<Map<string, ComponentContent>> {
  const valid = ids.filter((i) => UUID_RE.test(i));
  const out = new Map<string, ComponentContent>();
  if (!valid.length) return out;
  const { rows } = await db.query<{ id: string; name: string; design: unknown }>(
    'SELECT id, name, design FROM email_components WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
    [workspaceId, valid],
  );
  for (const r of rows) out.set(r.id, { name: r.name, rows: isEmailDesign(r.design) ? r.design.rows : [] });
  return out;
}

/**
 * Bring an email's linked components up to date before it is stored. Returns the
 * refreshed design and the MJML derived from it, or null when the design links
 * nothing (the caller's own MJML stands). The server re-derives the MJML here so
 * a stale editor tab can never save an out-of-date footer.
 */
export async function withFreshComponents(db: Db, workspaceId: string, design: unknown): Promise<{ design: EmailDesign; mjml: string } | null> {
  if (!isEmailDesign(design)) return null;
  const ids = componentIdsIn(design);
  if (!ids.length) return null;
  const fresh = refreshComponents(design, await loadComponents(db, workspaceId, ids));
  return { design: fresh, mjml: designToMjml(fresh) };
}

/** Normalize a component body: a design whose rows are never themselves links. */
function componentDesign(v: unknown): EmailDesign | null {
  if (!isEmailDesign(v)) return null;
  return { version: 1, settings: v.settings ?? {}, rows: expandComponents(v.rows) };
}

/** GET /email-components — the library, with each one's content (small). */
export const listEmailComponents: Handler = async (ctx, pool) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.design, c.updated_at,
            (SELECT count(*)::int FROM email_templates t
              WHERE t.workspace_id = c.workspace_id
                AND t.design->'rows' @> jsonb_build_array(jsonb_build_object('component', jsonb_build_object('id', c.id::text)))) AS used_by
       FROM email_components c WHERE c.workspace_id = $1 ORDER BY c.name`,
    [ctx.workspaceId],
  );
  return ok({ components: rows });
};

/** GET /email-components/:id */
export const getEmailComponent: Handler = async (ctx, pool, req) => {
  const id = req.params.id ?? '';
  if (!UUID_RE.test(id)) return ok({ error: 'not found' }, 404);
  const { rows } = await pool.query('SELECT id, name, design, updated_at FROM email_components WHERE workspace_id = $1 AND id = $2', [
    ctx.workspaceId,
    id,
  ]);
  if (!rows[0]) return ok({ error: 'not found' }, 404);
  return ok({ component: rows[0] });
};

/** POST /email-components {name, design} */
export const createEmailComponent: Handler = async (ctx, pool, req) => {
  const b = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return ok({ error: 'name required' }, 400);
  const design = componentDesign(b.design);
  if (!design) return ok({ error: 'design required' }, 400);
  const { rows } = await pool.query(
    'INSERT INTO email_components (workspace_id, name, design) VALUES ($1, $2, $3::jsonb) RETURNING id, name, design, updated_at',
    [ctx.workspaceId, name, JSON.stringify(design)],
  );
  return ok({ component: rows[0] }, 201);
};

/**
 * PUT /email-components/:id {name?, design?} — save, then refresh + recompile
 * every email linking to it, all in ONE transaction.
 */
export const updateEmailComponent: Handler = async (ctx, pool, req, deps) => {
  const id = req.params.id ?? '';
  if (!UUID_RE.test(id)) return ok({ error: 'not found' }, 404);
  const b = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : undefined;
  if (name === '') return ok({ error: 'name required' }, 400);
  const design = b.design === undefined ? undefined : componentDesign(b.design);
  if (design === null) return ok({ error: 'invalid design' }, 400);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE email_components SET name = COALESCE($3, name), design = COALESCE($4::jsonb, design), updated_at = now()
        WHERE workspace_id = $1 AND id = $2 RETURNING id, name, design, updated_at`,
      [ctx.workspaceId, id, name ?? null, design ? JSON.stringify(design) : null],
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return ok({ error: 'not found' }, 404);
    }
    const updated = await recompileLinkedTemplates(client, ctx.workspaceId, id, deps.compileMjml);
    await client.query('COMMIT');
    return ok({ component: rows[0], updated_emails: updated });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
};

/** Refresh + recompile every email in the workspace that links to `componentId`. */
async function recompileLinkedTemplates(db: Db, workspaceId: string, componentId: string, compile: (mjml: string) => string): Promise<number> {
  const { rows } = await db.query<{ id: string; design: unknown }>(
    `SELECT id, design FROM email_templates
      WHERE workspace_id = $1
        AND design->'rows' @> jsonb_build_array(jsonb_build_object('component', jsonb_build_object('id', $2::text)))
      FOR UPDATE`,
    [workspaceId, componentId],
  );
  for (const t of rows) {
    const fresh = await withFreshComponents(db, workspaceId, t.design);
    if (!fresh) continue;
    await db.query(
      'UPDATE email_templates SET design = $3::jsonb, mjml = $4, compiled_html = $5, updated_at = now() WHERE workspace_id = $1 AND id = $2',
      [workspaceId, t.id, JSON.stringify(fresh.design), fresh.mjml, compile(fresh.mjml)],
    );
  }
  return rows.length;
}

/**
 * DELETE /email-components/:id — emails linking to it keep their last snapshot
 * as a plain (unlinked) copy, so nothing that sends loses its footer.
 */
export const deleteEmailComponent: Handler = async (ctx, pool, req) => {
  const id = req.params.id ?? '';
  if (!UUID_RE.test(id)) return ok({ error: 'not found' }, 404);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string; design: unknown }>(
      `SELECT id, design FROM email_templates
        WHERE workspace_id = $1
          AND design->'rows' @> jsonb_build_array(jsonb_build_object('component', jsonb_build_object('id', $2::text)))
        FOR UPDATE`,
      [ctx.workspaceId, id],
    );
    for (const t of rows) {
      if (!isEmailDesign(t.design)) continue;
      const unlinked: EmailDesign = { ...t.design, rows: unlinkRows(t.design.rows, id) };
      await client.query('UPDATE email_templates SET design = $3::jsonb, updated_at = now() WHERE workspace_id = $1 AND id = $2', [
        ctx.workspaceId,
        t.id,
        JSON.stringify(unlinked),
      ]);
    }
    const del = await client.query('DELETE FROM email_components WHERE workspace_id = $1 AND id = $2', [ctx.workspaceId, id]);
    if (!del.rowCount) {
      await client.query('ROLLBACK');
      return ok({ error: 'not found' }, 404);
    }
    await client.query('COMMIT');
    return ok({ deleted: 1, unlinked_emails: rows.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
};

/** Inline one component's snapshot in place of its links, with fresh ids. */
function unlinkRows(rows: EmailDesign['rows'], componentId: string): EmailDesign['rows'] {
  // Past any numeric id already used, so the designer's id counter never collides.
  let n = 1_000_000 + Math.floor(Math.random() * 1_000_000);
  const newId = (prefix: string): string => `${prefix}-${n++}`;
  return rows.flatMap((r) => (r.component?.id === componentId ? cloneRowsWithFreshIds(r.component.rows, newId) : [r]));
}
