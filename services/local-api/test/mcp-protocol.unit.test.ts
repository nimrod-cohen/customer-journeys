// MCP JSON-RPC core — pure behaviour (no DB).
import { describe, it, expect, vi } from 'vitest';
import { handleMcpMessage, validateArgs, ToolError, MCP_LATEST, RPC, type McpTool } from '../src/mcp/protocol.js';
import { MCP_TOOLS } from '../src/mcp/tools.js';
import { HANDLERS } from '../src/handlers.js';
import { capabilityForRoute } from '../src/routes.js';

const INFO = { name: 'cj', version: '1.2.3', instructions: 'be nice' };
const echo: McpTool<null> = {
  name: 'echo',
  title: 'Echo',
  description: 'echo',
  readOnly: true,
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  run: async (a) => ({ said: a.text }),
};
const boom: McpTool<null> = { ...echo, name: 'boom', readOnly: false, inputSchema: { type: 'object' }, run: async () => { throw new ToolError('nope'); } };
const crash: McpTool<null> = { ...boom, name: 'crash', run: async () => { throw new Error('db down'); } };
const tools = [echo, boom, crash];
const rpc = (method: string, params?: unknown, id: number | null = 1) => ({ jsonrpc: '2.0', ...(id !== null ? { id } : {}), method, ...(params ? { params } : {}) });

describe('handleMcpMessage', () => {
  it('initialize negotiates the protocol version and advertises tools', async () => {
    const r = await handleMcpMessage(rpc('initialize', { protocolVersion: '2025-03-26' }), tools, null, INFO);
    expect(r?.result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'cj', version: '1.2.3' }, instructions: 'be nice' });
    const r2 = await handleMcpMessage(rpc('initialize', { protocolVersion: '1999-01-01' }), tools, null, INFO);
    expect((r2?.result as { protocolVersion: string }).protocolVersion).toBe(MCP_LATEST);
  });

  it('notifications and client responses get no reply', async () => {
    expect(await handleMcpMessage(rpc('notifications/initialized', undefined, null), tools, null, INFO)).toBeNull();
    expect(await handleMcpMessage({ jsonrpc: '2.0', id: 5, result: {} }, tools, null, INFO)).toBeNull();
  });

  it('ping, unknown method, invalid request', async () => {
    expect((await handleMcpMessage(rpc('ping'), tools, null, INFO))?.result).toEqual({});
    expect((await handleMcpMessage(rpc('resources/list'), tools, null, INFO))?.error?.code).toBe(RPC.METHOD_NOT_FOUND);
    expect((await handleMcpMessage({ hello: 1 }, tools, null, INFO))?.error?.code).toBe(RPC.INVALID_REQUEST);
  });

  it('tools/list carries schemas and read-only hints', async () => {
    const r = await handleMcpMessage(rpc('tools/list'), tools, null, INFO);
    const listed = (r?.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] }).tools;
    expect(listed.map((t) => t.name)).toEqual(['echo', 'boom', 'crash']);
    expect(listed[0]!.annotations.readOnlyHint).toBe(true);
    expect(listed[1]!.annotations.readOnlyHint).toBe(false);
  });

  it('tools/call: success, bad args, tool error, crash, unknown tool', async () => {
    const ok = await handleMcpMessage(rpc('tools/call', { name: 'echo', arguments: { text: 'hi' } }), tools, null, INFO);
    expect(ok?.result).toMatchObject({ isError: false, structuredContent: { said: 'hi' } });
    const bad = await handleMcpMessage(rpc('tools/call', { name: 'echo', arguments: {} }), tools, null, INFO);
    expect(bad?.result).toMatchObject({ isError: true, content: [{ text: 'arguments.text is required' }] });
    const extra = await handleMcpMessage(rpc('tools/call', { name: 'echo', arguments: { text: 'x', y: 1 } }), tools, null, INFO);
    expect((extra?.result as { isError: boolean }).isError).toBe(true);
    const te = await handleMcpMessage(rpc('tools/call', { name: 'boom' }), tools, null, INFO);
    expect(te?.result).toMatchObject({ isError: true, content: [{ text: 'nope' }] });
    const cr = await handleMcpMessage(rpc('tools/call', { name: 'crash' }), tools, null, INFO);
    expect((cr?.result as { content: { text: string }[] }).content[0]!.text).toMatch(/internal error: db down/);
    expect((await handleMcpMessage(rpc('tools/call', { name: 'nah' }), tools, null, INFO))?.error?.code).toBe(RPC.INVALID_PARAMS);
  });

  it('calls the audit hook, and a failing hook never fails the call', async () => {
    const onToolCall = vi.fn().mockRejectedValue(new Error('audit down'));
    const r = await handleMcpMessage(rpc('tools/call', { name: 'boom' }), tools, null, INFO, { onToolCall });
    expect(onToolCall).toHaveBeenCalledWith(boom, false, 'nope');
    expect((r?.result as { isError: boolean }).isError).toBe(true);
  });
});

describe('validateArgs', () => {
  it('checks types, enums, arrays and integers', () => {
    const schema = {
      type: 'object' as const,
      properties: { n: { type: 'integer' as const }, e: { type: 'string' as const, enum: ['a', 'b'] }, l: { type: 'array' as const, items: { type: 'string' as const } }, b: { type: 'boolean' as const } },
    };
    expect(validateArgs(schema, { n: 1, e: 'a', l: ['x'], b: true })).toBeNull();
    expect(validateArgs(schema, { n: 1.5 })).toMatch(/integer/);
    expect(validateArgs(schema, { e: 'c' })).toMatch(/one of/);
    expect(validateArgs(schema, { l: [1] })).toMatch(/l\[0\]/);
    expect(validateArgs(schema, { b: 'yes' })).toMatch(/true or false/);
    expect(validateArgs(schema, 'x')).toMatch(/object/);
  });
});

describe('the tool set', () => {
  it('exposes no publish / send / schedule / enroll / delete capability', () => {
    const names = MCP_TOOLS.map((t) => t.name).join(' ');
    expect(names).not.toMatch(/publish|send_broadcast|schedule|enroll|delete|activate|resume|archive/);
  });
  it('has unique names and object schemas that forbid unknown arguments', () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of MCP_TOOLS) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
  });
  it('only calls routes that exist and that a marketer may use', async () => {
    // Every route string in the tool source must be a registered, manage_content route.
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/mcp/tools.ts', import.meta.url), 'utf8'));
    const routes = [...src.matchAll(/rt\.call\('([A-Z]+ [^']+)'/g)].map((m) => m[1]!);
    expect(routes.length).toBeGreaterThan(15);
    for (const r of routes) {
      expect(HANDLERS[r], r).toBeTypeOf('function');
      expect(capabilityForRoute(r), r).toBe('manage_content');
    }
    expect(routes.some((r) => /publish|\/send$|\/enroll$|activate|resume|DELETE/.test(r))).toBe(false);
  });
});
