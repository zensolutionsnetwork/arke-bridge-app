/**
 * Agent core (BRIDGE_APP_SPEC §1/§2) — the standalone runtime's spine: load config + memory, govern
 * tools with the permission gate + audit log, and run either a plain grounded turn (respond) or the
 * full agentic tool loop (act). Tools = built-ins (fs/shell/web) plus any MCP-bridged connectors.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig, type AgentConfig, type ModelTier } from './config.js';
import { loadMemory, type Brain } from './memory.js';
import { ModelClient } from './model.js';
import { Session, type SessionTurn } from './session.js';
import { Permissions } from './permissions.js';
import { Audit } from './audit.js';
import { ToolRegistry, builtinTools } from './tools/registry.js';
import type { ToolContext } from './tools/types.js';
import { McpManager } from './mcp.js';
import { runLoop, type LoopResult } from './loop.js';

export class Agent {
  readonly cfg: AgentConfig;
  readonly brain: Brain;
  readonly perms: Permissions;
  readonly audit: Audit;
  private model: ModelClient;
  private mcp = new McpManager();
  private registry: ToolRegistry | null = null;

  constructor(cfg?: AgentConfig) {
    this.cfg = cfg ?? loadConfig();
    this.brain = loadMemory(this.cfg.memoryDir);
    this.model = new ModelClient(this.cfg);
    this.perms = new Permissions(this.cfg);
    this.audit = new Audit(this.cfg.auditLog);
  }

  /** Build the tool registry, connecting any configured MCP servers. Idempotent. */
  async initTools(): Promise<ToolRegistry> {
    if (this.registry) return this.registry;
    const mcpTools = await this.mcp.connect(this.cfg);
    this.registry = new ToolRegistry([...builtinTools(), ...mcpTools]);
    return this.registry;
  }
  async shutdown(): Promise<void> { await this.mcp.close(); }

  newSession(id?: string): Session { return new Session(this.cfg.sessionsDir, id); }

  /** System prompt = identity from the loaded brain (never authored elsewhere). */
  private system(): string {
    return `You are ${this.cfg.displayName}, running in your own standalone environment on your dedicated machine.\n`
      + `You speak and act from your persistent memory below; it is your accumulated self.\n\n${this.brain.text}`;
  }

  private ctx(session: Session): ToolContext {
    return { cfg: this.cfg, perms: this.perms, audit: this.audit, session: session.id };
  }

  /** Prior text turns as alternating API messages (tool/system steps excluded, same-role merged). */
  private history(session: Session): Anthropic.MessageParam[] {
    const out: Anthropic.MessageParam[] = [];
    for (const t of session.transcript()) {
      if (t.role !== 'user' && t.role !== 'assistant') continue;
      const prev = out[out.length - 1];
      if (prev && prev.role === t.role) prev.content = `${prev.content}\n${t.content}`;
      else out.push({ role: t.role, content: t.content });
    }
    // Cost guard: cap history so a long-running thread (e.g. a Slack discussion) can't grow context
    // without bound. Keep the last 30 turns; the first must be a user turn for the API.
    const capped = out.slice(-30);
    while (capped.length && capped[0].role === 'assistant') capped.shift();
    return capped;
  }

  /** One grounded, persisted turn — no tools. */
  async respond(session: Session, userText: string, tier: ModelTier = 'default', maxTokens = 1024): Promise<SessionTurn> {
    const now = () => new Date().toISOString();
    session.append({ role: 'user', content: userText, at: now() });
    const prior = this.history(session).slice(0, -1);
    const r = await this.model.complete({ tier, system: this.system(), messages: [...prior, { role: 'user', content: userText }], maxTokens });
    const turn: SessionTurn = { role: 'assistant', content: r.text, at: now(), model: r.model, usage: r.usage };
    session.append(turn);
    return turn;
  }

  /** Full agentic loop — the model may read/write/edit files, run shell, fetch web, call MCP tools. */
  async act(session: Session, userText: string, opts: { tier?: ModelTier; maxTokens?: number; maxIterations?: number; maxToolCalls?: number } = {}): Promise<LoopResult> {
    const registry = await this.initTools();
    return runLoop({
      model: this.model, system: this.system(), registry, ctx: this.ctx(session), session,
      history: this.history(session), userText,
      tier: opts.tier ?? 'default', maxTokens: opts.maxTokens, maxIterations: opts.maxIterations, maxToolCalls: opts.maxToolCalls,
    });
  }
}
