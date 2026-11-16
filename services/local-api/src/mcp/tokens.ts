// MCP access tokens — minting, resolution, and the owner-gated CRUD handlers.
// A token is stored as a sha256 hash only (shown once). It acts as a MARKETER on
// behalf of the user who created it, and only while that user is still an owner
// or marketer of the workspace — removing the person disables their tokens.
import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { WorkspaceContext } from '@cdp/shared';
import type { Handler, HandlerResponse } from '../handlers.js';

export const MCP_TOKEN_PREFIX = 'mcp_';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ok = (body: unknown, status = 200): HandlerResponse => ({ status, body });

export function hashMcpToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function mintMcpToken(): { raw: string; hash: string; prefix: string } {
  const raw = MCP_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return { raw, hash: hashMcpToken(raw), prefix: raw.slice(0, 12) };
}

/** Who a valid token acts as. */
export interface McpPrincipal {
  readonly tokenId: string;
  readonly tokenName: string;
  readonly ctx: WorkspaceContext;
}

/**
 * Resolve a raw bearer to its principal, or null (unknown, revoked, or its creator
 * is no longer an owner/marketer of the workspace, or the workspace is not active).
 * The workspace comes from the TOKEN ROW, never the request (inv.2). The context is
 * always role 'marketer' — enough to draft, never to manage users, domains or keys.
 */
export async function resolveMcpToken(pool: Pool, raw: string | null): Promise<McpPrincipal | null> {
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (!token.startsWith(MCP_TOKEN_PREFIX)) return null;
  const { rows } = await pool.query<{ id: string; name: string; workspace_id: string; created_by: string; company_id: string | null }>(
    `UPDATE mcp_tokens t SET last_used_at = now()
       FROM workspace_users wu, workspaces w
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL
        AND wu.workspace_id = t.workspace_id AND wu.user_id = t.created_by
        AND wu.role IN ('owner', 'marketer')
        AND w.id = t.workspace_id AND w.status = 'active'
      RETURNING t.id, t.name, t.workspace_id, t.created_by, w.company_id`,
    [hashMcpToken(token)],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    tokenId: r.id,
    tokenName: r.name,
    ctx: { workspaceId: r.workspace_id, userId: r.created_by, companyId: r.company_id, role: 'marketer', isPlatformAdmin: false },
  };
}

/** GET /workspace/mcp-tokens — list (never the hash). */
export const listMcpTokens: Handler = async (ctx, pool) => {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.token_prefix, t.created_at, t.last_used_at, t.revoked_at, u.email AS created_by_email
       FROM mcp_tokens t LEFT JOIN users u ON u.id = t.created_by
      WHERE t.workspace_id = $1 ORDER BY t.created_at DESC`,
    [ctx.workspaceId],
  );
  return ok({ tokens: rows });
};

/** POST /workspace/mcp-tokens {name} — mint; the raw token is returned ONCE. */
export const createMcpToken: Handler = async (ctx, pool, req) => {
  const b = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return ok({ error: 'name required' }, 400);
  if (name.length > 100) return ok({ error: 'name too long' }, 400);
  if (!ctx.userId) return ok({ error: 'a signed-in user is required' }, 403);
  const { raw, hash, prefix } = mintMcpToken();
  const { rows } = await pool.query<{ id: string; created_at: string }>(
    `INSERT INTO mcp_tokens (workspace_id, name, token_hash, token_prefix, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
    [ctx.workspaceId, name, hash, prefix, ctx.userId],
  );
  return ok({ id: rows[0]!.id, name, token: raw, token_prefix: prefix, created_at: rows[0]!.created_at }, 201);
};

/** DELETE /workspace/mcp-tokens/:id — revoke (refused immediately). */
export const revokeMcpToken: Handler = async (ctx, pool, req) => {
  const id = req.params.id ?? '';
  if (!UUID_RE.test(id)) return ok({ error: 'not found' }, 404);
  const { rowCount } = await pool.query(
    `UPDATE mcp_tokens SET revoked_at = now() WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL`,
    [ctx.workspaceId, id],
  );
  if (!rowCount) return ok({ error: 'not found' }, 404);
  return ok({ revoked: 1 });
};
