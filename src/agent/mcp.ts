/**
 * MCP client (BRIDGE_APP_SPEC §1: "MCP client support so existing connectors still plug in").
 *
 * Connects to each server in `config.mcpServers` over stdio, discovers its tools, and bridges them
 * into the same Tool interface the built-ins use — exposed to the model as `mcp__<server>__<tool>`
 * and governed by the single 'mcp' permission scope. No server configured = a clean no-op.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from './tools/types.js';
import type { AgentConfig } from './config.js';

export interface McpServerSpec { command: string; args?: string[]; env?: Record<string, string> }

export class McpManager {
  private clients: Client[] = [];

  /** Connect every configured server and return the bridged tools. Safe to call with none configured. */
  async connect(cfg: AgentConfig): Promise<Tool[]> {
    const servers = cfg.mcpServers ?? {};
    const tools: Tool[] = [];
    for (const [server, spec] of Object.entries(servers)) {
      const transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args ?? [],
        env: { ...process.env as Record<string, string>, ...(spec.env ?? {}) },
      });
      const client = new Client({ name: `arke-bridge:${server}`, version: '0.1.0' }, { capabilities: {} });
      await client.connect(transport);
      this.clients.push(client);
      const { tools: remote } = await client.listTools();
      for (const t of remote) tools.push(this.bridge(server, client, t));
    }
    return tools;
  }

  private bridge(server: string, client: Client, t: { name: string; description?: string; inputSchema?: any }): Tool {
    return {
      name: `mcp__${server}__${t.name}`,
      scope: 'mcp',
      description: `[${server}] ${t.description ?? t.name}`,
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      async run(input) {
        const res: any = await client.callTool({ name: t.name, arguments: input ?? {} });
        const text = Array.isArray(res.content)
          ? res.content.map((c: any) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')
          : String(res.content ?? '');
        return { content: text || '(no content)', isError: res.isError === true };
      },
    };
  }

  async close(): Promise<void> {
    await Promise.all(this.clients.map((c) => c.close().catch(() => {})));
    this.clients = [];
  }
}
