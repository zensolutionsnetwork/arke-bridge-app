/**
 * Tool abstraction shared by built-in tools and MCP-bridged tools. Each tool declares the permission
 * scope it needs and an explicit path argument (if any) so the gate can govern it BEFORE it runs.
 */
import type { Permissions, Scope } from '../permissions.js';
import type { Audit } from '../audit.js';
import type { AgentConfig } from '../config.js';

export interface ToolContext {
  cfg: AgentConfig;
  perms: Permissions;
  audit: Audit;
  session?: string;
}

export interface ToolResult { content: string; isError?: boolean }

export interface Tool {
  name: string;
  scope: Scope;
  description: string;
  inputSchema: Record<string, unknown>;     // JSON Schema object passed to the model
  /** Resolve the filesystem path this call will touch, for the path gate. Omit for non-fs tools. */
  pathArg?: (input: any) => string | undefined;
  run(input: any, ctx: ToolContext): Promise<ToolResult>;
}
