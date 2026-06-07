/**
 * Rituals — the named jobs the scheduler runs (BRIDGE_APP_SPEC §6.2: first rituals = handoff +
 * backlog sync). Each is `(ctx) => RitualResult`; the scheduler maps a config task's `ritual` field
 * to one of these. They degrade honestly: a hub-dependent ritual reports "skipped" when the 3080 has
 * no hub credential yet, rather than failing the run.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Agent } from './core.js';
import type { HubClient } from './hub.js';

export interface RitualContext {
  agent: Agent;
  hub: HubClient;
  councilRepo: string;
  log: (m: string) => void;
}
export interface RitualResult { ok: boolean; summary: string; skipped?: boolean }
export type Ritual = (ctx: RitualContext) => Promise<RitualResult>;

/**
 * Day-close handoff — the agent reads the council repo's handoff + agenda and its own recent work,
 * then writes an updated DAILY_HANDOFF.md. This is the v1 close ritual, now run by the agent itself
 * instead of a Cowork engineer. Uses the tool loop (read + write), so it is fully self-contained.
 */
export const handoff: Ritual = async ({ agent, councilRepo, log }) => {
  const target = path.join(councilRepo, 'DAILY_HANDOFF.md');
  const agenda = path.join(councilRepo, 'COUNCIL_AGENDA.md');
  const session = agent.newSession();
  const prompt =
    `Daily close ritual. Read these two files: ${target} and ${agenda}. `
    + `Then write an updated day-close handoff to ${target}. Keep it concise and factual: today's date, `
    + `what changed today, current state of the v2 build, open items, and anything to raise with Mathieu. `
    + `Preserve any still-relevant content. Use the write_file tool to save it. Then reply with a one-line summary.`;
  // Routine tier (spec §1: cheaper tiers for routine rituals) — handoffs are concise factual summaries.
  const r = await agent.act(session, prompt, { tier: 'routine', maxTokens: 2048 });
  log(`handoff: ${r.toolCalls} tool calls, ${r.usage.input}+${r.usage.output} tokens`);
  return { ok: fs.existsSync(target), summary: r.text.slice(0, 200) || 'handoff written' };
};

/**
 * Backlog sync — mirror the hub's canonical living backlog to a local file so the standalone always
 * has it current. Pull-only for now (safe); push direction is added when the 3080 holds a hub token.
 */
export const backlogSync: Ritual = async ({ hub, councilRepo, log }) => {
  if (!hub.configured()) return { ok: true, skipped: true, summary: 'skipped: no hub credential on this machine yet' };
  const b = await hub.getBacklog();
  const local = path.join(councilRepo, 'LIVING_BACKLOG.md');
  fs.writeFileSync(local, `# Living backlog (mirrored from hub ${b.updatedAt ?? ''})\n\n${b.content}\n`, 'utf8');
  log(`backlog-sync: mirrored ${b.content.length} chars to ${local}`);
  return { ok: true, summary: `mirrored hub backlog (${b.content.length} chars)` };
};

export const RITUALS: Record<string, Ritual> = { handoff, 'backlog-sync': backlogSync };
