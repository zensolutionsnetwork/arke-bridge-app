/**
 * Agent core (BRIDGE_APP_SPEC §1) — the standalone runtime's spine: load config + memory, run a
 * turn against the tier-selected model, persist every turn to the session transcript. Tools/MCP and
 * the scheduler layer on top of this; today it is a memory-grounded, durable single-turn loop.
 */
import { loadConfig, type AgentConfig, type ModelTier } from './config.js';
import { loadMemory, type Brain } from './memory.js';
import { ModelClient } from './model.js';
import { Session, type SessionTurn } from './session.js';

export class Agent {
  readonly cfg: AgentConfig;
  readonly brain: Brain;
  private model: ModelClient;

  constructor(cfg?: AgentConfig) {
    this.cfg = cfg ?? loadConfig();
    this.brain = loadMemory(this.cfg.memoryDir);
    this.model = new ModelClient(this.cfg);
  }

  newSession(id?: string): Session { return new Session(this.cfg.sessionsDir, id); }

  /** System prompt = identity from the loaded brain (never authored elsewhere). */
  private system(): string {
    return `You are ${this.cfg.displayName}, running in your own standalone environment on your dedicated machine.\n`
      + `You speak and act from your persistent memory below; it is your accumulated self.\n\n${this.brain.text}`;
  }

  /** One grounded, persisted turn. Appends the user message and the reply to the session transcript. */
  async respond(session: Session, userText: string, tier: ModelTier = 'default', maxTokens = 1024): Promise<SessionTurn> {
    const now = () => new Date().toISOString();
    session.append({ role: 'user', content: userText, at: now() });
    const prior = session.transcript()
      .filter((t) => t.role !== 'system')
      .map((t) => ({ role: t.role as 'user' | 'assistant', content: t.content }));
    const r = await this.model.complete({ tier, system: this.system(), messages: prior, maxTokens });
    const turn: SessionTurn = { role: 'assistant', content: r.text, at: now(), model: r.model, usage: r.usage };
    session.append(turn);
    return turn;
  }
}
