/**
 * Slack bridge — a two-way command channel so Mathieu can direct Arke from his phone (BRIDGE_APP_SPEC:
 * an owner surface). Socket Mode (no public URL / port-forward needed — right for a home 3080). A DM
 * or @mention from the OWNER is run through the agent with the same guardrails as the env channel
 * (permission gate + tool-call backstop); the reply is posted back. Only SLACK_OWNER_ID is obeyed.
 *
 * Tokens come from the env, never the config file:
 *   SLACK_BOT_TOKEN (xoxb-)  · SLACK_APP_TOKEN (xapp-, Socket Mode) · SLACK_OWNER_ID (U…)
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Agent } from './core.js';
import type { Session } from './session.js';

export interface SlackConfig { botToken?: string; appToken?: string; ownerId?: string }
export function slackConfigFromEnv(): SlackConfig {
  return { botToken: process.env.SLACK_BOT_TOKEN, appToken: process.env.SLACK_APP_TOKEN, ownerId: process.env.SLACK_OWNER_ID };
}

export class SlackBridge {
  private app: any = null;
  private sessions = new Map<string, Session>(); // one continuous discussion per Slack channel
  private resolvedOwner: string | undefined;     // locked owner (from config or trust-on-first-DM)
  private ownerFile: string;
  constructor(private agent: Agent, private cfg: SlackConfig) {
    this.ownerFile = path.join(agent.cfg.sessionsDir, 'slack-owner.id');
  }
  enabled(): boolean { return !!(this.cfg.botToken && this.cfg.appToken); }

  /** Resolve the owner: explicit config wins, else a previously locked id, else trust-on-first-DM. */
  private loadOwner(): void {
    this.resolvedOwner = this.cfg.ownerId
      || (fs.existsSync(this.ownerFile) ? fs.readFileSync(this.ownerFile, 'utf8').trim() : undefined);
  }
  private lockOwner(userId: string): void {
    this.resolvedOwner = userId;
    try { fs.mkdirSync(path.dirname(this.ownerFile), { recursive: true }); fs.writeFileSync(this.ownerFile, userId, 'utf8'); } catch { /* */ }
  }

  async start(): Promise<boolean> {
    if (!this.enabled()) return false;
    this.loadOwner();
    // Bolt v4 exposes named exports on the ESM namespace; older/CJS interop puts them under .default.
    const bolt: any = await import('@slack/bolt');
    const App = bolt.App ?? bolt.default?.App ?? bolt.default;
    const LogLevel = bolt.LogLevel ?? bolt.default?.LogLevel;
    this.app = new App({ token: this.cfg.botToken, appToken: this.cfg.appToken, socketMode: true, logLevel: LogLevel?.WARN ?? 'warn' });

    const handle = async (ev: any, say: any, client: any) => {
      if (ev.subtype || ev.bot_id || !ev.user) return;           // ignore edits, bot echoes
      // Trust-on-first-DM: the first human to message becomes the locked owner; everyone else is refused.
      if (!this.resolvedOwner) {
        this.lockOwner(ev.user);
        await say(`🔒 Locked to you (${ev.user}). I take direction only from you now, Mathieu.`);
      } else if (ev.user !== this.resolvedOwner) {
        await say('I take direction only from Mathieu.'); return;
      }
      const text = String(ev.text || '').replace(/<@[^>]+>/g, '').trim(); // strip the @mention
      if (!text) return;
      try { await client.reactions.add({ channel: ev.channel, timestamp: ev.ts, name: 'eyes' }); } catch { /* best-effort ack */ }
      try {
        let session = this.sessions.get(ev.channel);
        if (!session) { session = this.agent.newSession(); this.sessions.set(ev.channel, session); }
        const r = await this.agent.act(session, text, { tier: 'default', maxTokens: 2048, maxIterations: 12, maxToolCalls: 16 });
        await say(r.text || '(no reply)');
      } catch (e) {
        await say(`error: ${(e as Error).message}`);
      }
    };

    this.app.message(async ({ message, say, client }: any) => handle(message, say, client));      // DMs
    this.app.event('app_mention', async ({ event, say, client }: any) => handle(event, say, client));
    this.app.error(async (e: any) => { console.error('slack error:', e?.message || e); });
    await this.app.start();
    return true;
  }

  async stop(): Promise<void> { try { await this.app?.stop(); } catch { /* */ } }
}
