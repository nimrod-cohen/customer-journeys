// The HTTP face of the MCP server: POST /mcp with `Authorization: Bearer mcp_…`.
// Stateless — every request authenticates its token, so there is no session to
// hijack and nothing to clean up. Write-tool calls are audited in activity_log.
import type { Pool } from 'pg';
import type { LocalApiDeps } from '../deps.js';
import { handleMcpMessage, RPC, type JsonRpcResponse, type McpTool } from './protocol.js';
import { resolveMcpToken } from './tokens.js';
import { MCP_TOOLS, MCP_INSTRUCTIONS, makeToolRuntime, type ToolRuntime } from './tools.js';
import { extractBearer } from '../auth.js';

export const MCP_SERVER_NAME = 'customer-journeys';
/** Bounds one HTTP request: a batch of more messages is refused. */
export const MCP_MAX_BATCH = 20;

export interface McpHttpResult {
  readonly status: number;
  /** null = no body (202 for notifications only). */
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

/**
 * Handle one POST /mcp. `rawBody` is the parsed JSON (or the PARSE_ERROR sentinel).
 * Never throws.
 */
export async function handleMcpHttp(
  pool: Pool,
  deps: LocalApiDeps,
  authorization: string | null,
  rawBody: unknown,
  version: string,
  tools: readonly McpTool<ToolRuntime>[] = MCP_TOOLS,
): Promise<McpHttpResult> {
  const principal = await resolveMcpToken(pool, extractBearer(authorization));
  if (!principal) {
    return {
      status: 401,
      body: { error: 'invalid or revoked MCP token' },
      headers: { 'www-authenticate': 'Bearer realm="customer-journeys-mcp"' },
    };
  }
  if (rawBody === PARSE_ERROR) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: RPC.PARSE_ERROR, message: 'parse error' } } };
  }

  const rt = makeToolRuntime(principal.ctx, pool, deps);
  const info = { name: MCP_SERVER_NAME, version, instructions: MCP_INSTRUCTIONS };
  const hooks = {
    async onToolCall(tool: McpTool<never>, ok: boolean, detail: string) {
      if (tool.readOnly) return;
      await pool.query(
        `INSERT INTO activity_log (workspace_id, profile_id, source, type, outcome, detail)
         VALUES ($1, NULL, 'mcp', $2, $3, $4)`,
        [principal.ctx.workspaceId, tool.name, ok ? 'success' : 'failed', `${principal.tokenName}: ${ok ? tool.title : detail}`.slice(0, 500)],
      );
    },
  };

  const messages = Array.isArray(rawBody) ? rawBody : [rawBody];
  if (messages.length === 0 || messages.length > MCP_MAX_BATCH) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: RPC.INVALID_REQUEST, message: 'empty or oversized batch' } } };
  }
  const out: JsonRpcResponse[] = [];
  for (const m of messages) {
    const r = await handleMcpMessage(m, tools, rt, info, hooks);
    if (r) out.push(r);
  }
  if (out.length === 0) return { status: 202, body: null };
  return { status: 200, body: Array.isArray(rawBody) ? out : out[0] };
}

/** Sentinel for a body that was not valid JSON. */
export const PARSE_ERROR = Symbol('mcp-parse-error');
