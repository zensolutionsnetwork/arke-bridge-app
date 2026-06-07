/**
 * Agent-core config (BRIDGE_APP_SPEC §1/§2). The owner grants scopes ONCE here, per agent / tool /
 * path — not per prompt — so overnight runs never stall on approvals. Risky scopes (delete, spend,
 * publish) are listed explicitly; everything is meant to land in an audit log Mathieu can read.
 *
 * Loaded from `bridge.config.json` (if present) merged over defaults; a few env vars override paths
 * and the key. Nothing here reads a secret into the file — `ANTHROPIC_API_KEY` stays in the env.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type ModelTier = 'council' | 'default' | 'routine';

export interface AgentConfig {
  agentId: string;
  displayName: string;
  memoryDir: string;
  sessionsDir: string;
  auditLog: string;
  models: Record<ModelTier, string>;
  permissions: {
    allowTools: string[];   // tool names granted without a prompt
    allowPaths: string[];   // path prefixes the agent may read/write
    riskyScopes: string[];  // delete / spend / publish — explicit, logged, owner-granted
  };
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  councilRepo: string;       // the architect-council repo the rituals read/write
  // Hub credentials come from env vars (never stored here). adminToken = owner surfaces;
  // memberSecret = this agent's member identity for the env channel (the 3080 IS architect-council).
  hub: { baseUrl: string; adminTokenEnv: string; memberSecretEnv: string };
  scheduler: {
    timezone: string;
    statePath: string;
    tickMs: number;
    tasks: { id: string; ritual: string; at?: string; everyMs?: number; enabled?: boolean; catchUp?: boolean }[];
  };
}

const HOME = os.homedir();
export function defaultConfig(): AgentConfig {
  return {
    agentId: 'architect-council',
    displayName: 'Arke',
    // Arke's installed brain (memory--*.md → here). Override via BRIDGE_MEMORY_DIR.
    memoryDir: process.env.BRIDGE_MEMORY_DIR
      || path.join(HOME, '.claude', 'projects', 'C--Arke-architect-council', 'memory'),
    sessionsDir: process.env.BRIDGE_SESSIONS_DIR || path.join('C:', 'Arke', 'bridge-app', '.sessions'),
    auditLog: process.env.BRIDGE_AUDIT_LOG || path.join('C:', 'Arke', 'bridge-app', '.sessions', 'audit.log'),
    models: {
      council: 'claude-opus-4-8',            // council + code review — Opus depth (owner's decision)
      default: 'claude-sonnet-4-6',
      routine: 'claude-haiku-4-5-20251001',  // cheap tier for routine rituals
    },
    permissions: {
      allowTools: ['read', 'write', 'edit', 'shell', 'web', 'mcp'],
      allowPaths: [path.join('C:', 'Arke')],
      riskyScopes: [], // empty until the owner explicitly grants delete/spend/publish
    },
    councilRepo: process.env.BRIDGE_COUNCIL_REPO || path.join('C:', 'Arke', 'architect-council'),
    hub: { baseUrl: process.env.HUB_BASE_URL || 'https://architectscouncil.com', adminTokenEnv: 'COUNCIL_ADMIN_TOKEN', memberSecretEnv: 'COUNCIL_MEMBER_SECRET' },
    scheduler: {
      timezone: 'America/Toronto',          // the council cadence runs on Toronto time
      statePath: path.join('C:', 'Arke', 'bridge-app', '.sessions', 'scheduler-state.json'),
      tickMs: 30_000,
      // First rituals (§6.2): the day-close handoff, then the backlog mirror. Close window 02:00-02:30.
      tasks: [
        { id: 'handoff', ritual: 'handoff', at: '02:00', catchUp: true },
        { id: 'backlog-sync', ritual: 'backlog-sync', at: '02:05', catchUp: true },
        // Poll the hub env channel so Cowork (other PC) can task the 3080. Inert until the member
        // secret is set on this machine (the ritual skips cleanly).
        { id: 'env-poll', ritual: 'env-poll', everyMs: 60_000 },
      ],
    },
  };
}

export function loadConfig(file = path.join('C:', 'Arke', 'bridge-app', 'bridge.config.json')): AgentConfig {
  const base = defaultConfig();
  if (!fs.existsSync(file)) return base;
  try {
    const over = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AgentConfig>;
    return {
      ...base, ...over,
      models: { ...base.models, ...(over.models || {}) },
      permissions: { ...base.permissions, ...(over.permissions || {}) },
      mcpServers: { ...(base.mcpServers || {}), ...(over.mcpServers || {}) },
      hub: { ...base.hub, ...(over.hub || {}) },
      scheduler: { ...base.scheduler, ...(over.scheduler || {}) },
    };
  } catch (e) {
    throw new Error(`bad bridge.config.json: ${(e as Error).message}`);
  }
}
