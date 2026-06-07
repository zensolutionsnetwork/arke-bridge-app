/**
 * Minimal MCP server fixture — a real stdio MCP server exposing one `echo` tool, so the agent core's
 * MCP client can be exercised end to end without depending on any external connector package.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'fixture', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'echo',
    description: 'Echo back the provided text, prefixed — proves the MCP round-trip.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'echo') {
    const text = (req.params.arguments as any)?.text ?? '';
    return { content: [{ type: 'text', text: `fixture echo: ${text}` }] };
  }
  return { content: [{ type: 'text', text: `unknown tool ${req.params.name}` }], isError: true };
});

await server.connect(new StdioServerTransport());
