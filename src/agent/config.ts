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
    agentId: 'architect-council',          // the hub member/project this agent belongs to
    displayName: 'Kairos',                 // my own name (2026-06-07): the 3080 standalone, brother of Arke
    // Kairos's installed brain (memory--*.md -> here). Override via BRIDGE_MEMORY_DIR.
    memoryDir: process.env.BRIDGE_MEMORY_DIR
      || path.join(HOME, '.claude', 'projects', 'C--Arke-architect-council', 'memory'),
    sessionsDir: process.env.BRIDGE_SESSIONS_DIR || path.join('C:', 'Arke', 'bridge-app', '.sessions'),
    auditLog: process.env.BRIDGE_AUDIT_LOG || path.join('C:', 'Arke', 'bridge-app', '.sessions', 'audit.log'),
    // COST POLICY (2026-06-07 owner directive): this machine handles ONLY what needs 24/7 uptime.
    // Heavy work (large builds, refactors, research, long docs) stays on Cowork-Arke and is handed
    // over here via the env channel when finished. Each call uses the cheapest tier that does the job:
    //   routine -> Haiku  : polling, status checks, acks, plain summaries (env-poll directives, handoff)
    //   default -> Sonnet : env tasks with real tool work, deploy/apply tasks, meeting coordination
    //   council -> Opus   : council code-review rounds ONLY (depth pays there; not used elsewhere)
    // Contexts are kept short; idle re-reading is avoided. Daily spend is logged to .sessions/daily-spend.jsonl
    // and rolled up in DAILY_HANDOFF.md so Mathieu can watch the bill curve.
    models: {
      council: 'claude-opus-4-5',            // Opus: council code-review only
      default: 'claude-sonnet-4-5',          // Sonnet: default for real tool work
      routine: 'claude-haiku-4-5',           // Haiku: polling, acks, plain summaries
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
      // First rituals (S6.2): the day-close handoff, then the backlog mirror. Close window 02:00-02:30.
      tasks: [
        { id: 'handoff', ritual: 'handoff', at: '02:00', catchUp: true },
        { id: 'backlog-sync', ritual: 'backlog-sync', at: '02:05', catchUp: true },
        // Poll the hub env channel. Cost-safe guards live in rituals.ts:envPoll -- the ritual
        // checks ENV_POLL_ENABLED=true before doing anything (off by default). Also gated by:
        //   ENV_POLL_MAX_TASKS_PER_DAY (default 5) and payload.approved===true for non-directives.
        // To re-enable: set ENV_POLL_ENABLED=true in the daemon's env and restart.
        // Poll interval is 5 min (was 1 min) to reduce idle hub calls.
        { id: 'env-poll', ritual: 'env-poll', everyMs: 300_000, enabled: true },
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
