import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// README promises that export/import/forget/promote are all disabled unless
// AUDREY_ENABLE_ADMIN_TOOLS=1. REST enforces it per route; the MCP handlers
// each have to call requireAdminTools() themselves, so a new admin tool (or a
// refactor) can silently ship ungated. Pin the parity at the source level.
const ADMIN_TOOLS = ['memory_export', 'memory_import', 'memory_forget', 'memory_promote'];

function handlerSource(source, toolName) {
  const match = new RegExp(`server\\.tool\\(\\s*'${toolName}'`).exec(source);
  expect(match, `${toolName} is registered`).not.toBeNull();
  const start = match.index + match[0].length;
  const next = source.indexOf('server.tool(', start);
  return source.slice(start, next === -1 ? undefined : next);
}

describe('admin tool gate parity', () => {
  const mcpSource = readFileSync('mcp-server/index.ts', 'utf-8');
  const restSource = readFileSync('src/routes.ts', 'utf-8');

  for (const tool of ADMIN_TOOLS) {
    it(`MCP ${tool} calls requireAdminTools()`, () => {
      expect(handlerSource(mcpSource, tool)).toContain('requireAdminTools()');
    });
  }

  it('REST gates the same four surfaces', () => {
    for (const route of ['/v1/export', '/v1/import', '/v1/forget', '/v1/promote']) {
      const match = new RegExp(`app\\.(?:get|post)\\(\\s*'${route}'`).exec(restSource);
      expect(match, `${route} is registered`).not.toBeNull();
      expect(restSource.slice(match.index, match.index + 400)).toContain('allowAdminTools');
    }
  });
});
