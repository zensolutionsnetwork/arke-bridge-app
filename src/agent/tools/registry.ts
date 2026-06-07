/**
 * Tool registry — gathers the built-in tools (plus any MCP-bridged ones) into one set, exposes their
 * Anthropic tool schemas to the model, and resolves a tool by name for the loop to execute.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { Tool } from './types.js';
import { fsTools } from './fs.js';
import { shell } from './shell.js';
import { webTools } from './web.js';

export function builtinTools(): Tool[] {
  return [...fsTools, shell, ...webTools];
}

export class ToolRegistry {
  private byName = new Map<string, Tool>();
  constructor(tools: Tool[]) { for (const t of tools) this.byName.set(t.name, t); }
  get(name: string): Tool | undefined { return this.byName.get(name); }
  all(): Tool[] { return [...this.byName.values()]; }
  /** The schemas advertised to the model. */
  schemas(): Anthropic.Tool[] {
    return this.all().map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool.InputSchema }));
  }
}
