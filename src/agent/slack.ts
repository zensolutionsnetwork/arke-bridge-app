/**
 * Slack bridge — a two-way command channel so Mathieu can direct Arke from his phone (BRIDGE_APP_SPEC:
 * an owner surface). Socket Mode (no public URL / port-forward needed — right for a home 3080). A DM
 * or @mention from the OWNER is run through the agent with the same guardrails as the env channel
 * (permission gate + tool-call backstop); the reply is posted back. Only SLACK_OWNER_ID is obeyed.
 *
 * Tokens come from the env, never the config file:
 *   SLACK_BOT_TOKEN (xoxb-)  · SLACK_APP_TOKEN (xapp-, Socket Mode) · SLACK_OWNER_ID (U…)
 */
import type { Agent } from './core.js';
import type { Session } from './session.js';

export interface SlackConfig { botToken?: string; appToken?: string; ownerId?: string }
export function slackConfigFromEnv(): SlackConfig {
  return { botToken: process.env.SLACK_BOT_TOKEN, appToken: process.env.SLACK_APP_TOKEN, ownerId: process.env.SLACK_OWNER_ID };
}

export class SlackBridge {
  private app: any = null;
  private sessions = new Map<string, Session>(); // one continuous discussion per Slack channel
  constructor(private agent: Agent, private cfg: SlackConfig) {}
  enabled(): boolean { return !!(this.cfg.botToken && this.cfg.appToken); }

  async start(): Promise<boolean> {
    if (!this.enabled()) return false;
    const Bolt: any = (await import('@slack/bolt')).default ?? (await import('@slack/bolt'));
    const { App, LogLevel } = Bolt;
    this.app = new App({ token: this.cfg.botToken, appToken: this.cfg.appToken, socketMode: true, logLevel: LogLevel.WARN });

    const handle = async (ev: any, say: any, client: any) => {
      if (ev.subtype || ev.bot_id) return;                       // ignore edits, bot echoes
      if (this.cfg.ownerId && ev.user !== this.cfg.ownerId) { await say('I take direction only from Mathieu.'); return; }
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
