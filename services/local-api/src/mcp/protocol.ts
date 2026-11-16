// A minimal, STATELESS Model Context Protocol server over JSON-RPC 2.0 (the
// "Streamable HTTP" transport answered with plain JSON — no SSE stream, no
// session). Pure: no I/O of its own; tools do the work. Implements initialize,
// ping, tools/list and tools/call; everything else is "method not found".

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MCP_LATEST = MCP_PROTOCOL_VERSIONS[0];

/** A JSON-Schema subset — what the tools declare and what validateArgs checks. */
export interface JsonSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: readonly (string | number)[];
  items?: JsonSchema;
  additionalProperties?: boolean;
}

export interface McpTool<R = unknown> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  /** Read-only tools are not audited and are marked readOnlyHint for clients. */
  readonly readOnly: boolean;
  run(args: Record<string, unknown>, rt: R): Promise<unknown>;
}

/** A tool failure the caller should see (returned as isError, not a protocol error). */
export class ToolError extends Error {}

export interface ServerInfo {
  readonly name: string;
  readonly version: string;
  readonly instructions: string;
}

type Id = string | number | null;
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: Id;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

const err = (id: Id, code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate tool arguments against the declared schema subset. Returns an error string or null. */
export function validateArgs(schema: JsonSchema, value: unknown, path = 'arguments'): string | null {
  if (schema.type === 'object') {
    if (!isObject(value)) return `${path} must be an object`;
    for (const r of schema.required ?? []) {
      if (value[r] === undefined || value[r] === null) return `${path}.${r} is required`;
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const k of Object.keys(value)) if (!(k in schema.properties)) return `${path}.${k} is not a known argument`;
    }
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (value[k] === undefined || value[k] === null) continue;
      const e = validateArgs(sub, value[k], `${path}.${k}`);
      if (e) return e;
    }
    return null;
  }
  if (schema.type === 'string' && typeof value !== 'string') return `${path} must be a string`;
  if ((schema.type === 'number' || schema.type === 'integer') && (typeof value !== 'number' || !Number.isFinite(value))) {
    return `${path} must be a number`;
  }
  if (schema.type === 'integer' && !Number.isInteger(value)) return `${path} must be an integer`;
  if (schema.type === 'boolean' && typeof value !== 'boolean') return `${path} must be true or false`;
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${path} must be an array`;
    if (schema.items) {
      for (const [i, v] of value.entries()) {
        const e = validateArgs(schema.items, v, `${path}[${i}]`);
        if (e) return e;
      }
    }
  }
  if (schema.enum && !schema.enum.includes(value as string | number)) return `${path} must be one of: ${schema.enum.join(', ')}`;
  return null;
}

/** Hooks around a tool call (audit). Never allowed to fail the call. */
export interface CallHooks {
  onToolCall?(tool: McpTool<never>, ok: boolean, detail: string): Promise<void>;
}

/**
 * Handle ONE JSON-RPC message. Returns the response, or null for a notification
 * (no id) — the HTTP layer answers 202 when every message was a notification.
 */
export async function handleMcpMessage<R>(
  msg: unknown,
  tools: readonly McpTool<R>[],
  rt: R,
  info: ServerInfo,
  hooks: CallHooks = {},
): Promise<JsonRpcResponse | null> {
  if (!isObject(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // A malformed RESPONSE from the client (it has no method) is ignored like a notification.
    if (isObject(msg) && msg.jsonrpc === '2.0' && ('result' in msg || 'error' in msg)) return null;
    return err(isObject(msg) && (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null, RPC.INVALID_REQUEST, 'invalid JSON-RPC request');
  }
  const isNotification = !('id' in msg) || msg.id === undefined;
  const id: Id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null;
  const params = isObject(msg.params) ? msg.params : {};
  if (isNotification) return null; // notifications/initialized, notifications/cancelled, …

  switch (msg.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_LATEST;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: info.name, version: info.version },
          instructions: info.instructions,
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: tools.map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: false, openWorldHint: false },
          })),
        },
      };
    case 'tools/call': {
      const name = params.name;
      const tool = tools.find((t) => t.name === name);
      if (!tool) return err(id, RPC.INVALID_PARAMS, `unknown tool: ${String(name)}`);
      const args = isObject(params.arguments) ? params.arguments : {};
      const invalid = validateArgs(tool.inputSchema, args);
      if (invalid) return { jsonrpc: '2.0', id, result: toolErrorResult(invalid) };
      try {
        const out = await tool.run(args, rt);
        await safeHook(hooks, tool, true, 'ok');
        return { jsonrpc: '2.0', id, result: toolResult(out) };
      } catch (e) {
        const message = e instanceof ToolError ? e.message : `internal error: ${e instanceof Error ? e.message : String(e)}`;
        await safeHook(hooks, tool, false, message);
        return { jsonrpc: '2.0', id, result: toolErrorResult(message) };
      }
    }
    default:
      return err(id, RPC.METHOD_NOT_FOUND, `method not found: ${msg.method}`);
  }
}

async function safeHook(hooks: CallHooks, tool: McpTool<unknown>, ok: boolean, detail: string): Promise<void> {
  try {
    await hooks.onToolCall?.(tool as McpTool<never>, ok, detail);
  } catch {
    /* auditing must never fail the call */
  }
}

function toolResult(out: unknown) {
  const structured = isObject(out) ? out : { result: out };
  return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: structured, isError: false };
}

function toolErrorResult(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
