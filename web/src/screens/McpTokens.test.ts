import { describe, it, expect } from 'vitest';
import { mcpEndpoint, claudeCodeCommand } from './McpTokens.js';

describe('MCP connection helpers', () => {
  it('builds the endpoint from an absolute or same-origin API base', () => {
    expect(mcpEndpoint('http://localhost:8787', 'http://localhost:5173')).toBe('http://localhost:8787/mcp');
    expect(mcpEndpoint('https://api.example.com/', 'https://app.example.com')).toBe('https://api.example.com/mcp');
    expect(mcpEndpoint('', 'https://journeys.example.com')).toBe('https://journeys.example.com/mcp');
  });
  it('builds the Claude Code command', () => {
    expect(claudeCodeCommand('https://x.test/mcp', 'mcp_abc')).toBe(
      'claude mcp add --transport http customer-journeys https://x.test/mcp --header "Authorization: Bearer mcp_abc"',
    );
  });
});
