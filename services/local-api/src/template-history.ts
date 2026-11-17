// The email designer's change history, saved server-side so it survives leaving
// the editor. The editor sends the entries recorded since its last save with each
// autosave (`history_append`); we keep the newest MAX_HISTORY per template.
import type { Pool } from 'pg';
import type { Handler, HandlerResponse } from './handlers.js';

export const MAX_TEMPLATE_HISTORY = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ok = (body: unknown, status = 200): HandlerResponse => ({ status, body });

interface Entry {
  action: string;
  snapshot: unknown;
  at: Date;
}

/** Validate the `history_append` body field; junk entries are dropped, never fatal. */
export function parseHistoryAppend(v: unknown): Entry[] {
  if (!Array.isArray(v)) return [];
  const out: Entry[] = [];
  for (const e of v.slice(-MAX_TEMPLATE_HISTORY * 2)) {
    if (!e || typeof e !== 'object') continue;
    const r = e as { action?: unknown; snapshot?: unknown; timestamp?: unknown };
    const snap = typeof r.snapshot === 'string' ? safeParse(r.snapshot) : r.snapshot;
    if (!snap || typeof snap !== 'object' || (snap as { version?: unknown }).version !== 1) continue;
    const at = typeof r.timestamp === 'number' && Number.isFinite(r.timestamp) ? new Date(r.timestamp) : new Date();
    out.push({ action: typeof r.action === 'string' ? r.action.slice(0, 200) : 'Edit', snapshot: snap, at });
  }
  return out.slice(-MAX_TEMPLATE_HISTORY);
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Append entries for a template already verified to be in `workspaceId`, then
 * trim to the newest MAX_TEMPLATE_HISTORY. Best-effort: history must never fail
 * the save it rides on.
 */
export async function appendTemplateHistory(pool: Pool, workspaceId: string, templateId: string, entries: Entry[]): Promise<void> {
  if (!entries.length) return;
  try {
    await pool.query(
      `INSERT INTO email_template_history (workspace_id, template_id, action, snapshot, created_at)
       SELECT $1, $2, e.action, e.snapshot, e.at
         FROM jsonb_to_recordset($3::jsonb) AS e(action text, snapshot jsonb, at timestamptz)`,
      [workspaceId, templateId, JSON.stringify(entries.map((e) => ({ action: e.action, snapshot: e.snapshot, at: e.at.toISOString() })))],
    );
    await pool.query(
      `DELETE FROM email_template_history
        WHERE workspace_id = $1 AND template_id = $2
          AND id < (SELECT min(id) FROM (SELECT id FROM email_template_history
                     WHERE workspace_id = $1 AND template_id = $2 ORDER BY id DESC LIMIT $3) newest)`,
      [workspaceId, templateId, MAX_TEMPLATE_HISTORY],
    );
  } catch {
    /* history is a convenience — never fail the save */
  }
}

/** GET /templates/:id/history — oldest first, in the editor's HistoryEntry shape. */
export const getTemplateHistory: Handler = async (ctx, pool, req) => {
  const id = req.params.id ?? '';
  if (!UUID_RE.test(id)) return ok({ error: 'not found' }, 404);
  const own = await pool.query('SELECT 1 FROM email_templates WHERE workspace_id = $1 AND id = $2', [ctx.workspaceId, id]);
  if (!own.rowCount) return ok({ error: 'not found' }, 404);
  const { rows } = await pool.query<{ action: string; snapshot: unknown; created_at: Date }>(
    `SELECT action, snapshot, created_at FROM (
       SELECT id, action, snapshot, created_at FROM email_template_history
        WHERE workspace_id = $1 AND template_id = $2 ORDER BY id DESC LIMIT $3
     ) h ORDER BY id`,
    [ctx.workspaceId, id, MAX_TEMPLATE_HISTORY],
  );
  return ok({
    history: rows.map((r) => ({ action: r.action, snapshot: JSON.stringify(r.snapshot), timestamp: new Date(r.created_at).getTime() })),
  });
};
