/**
 * Rituals -- the named jobs the scheduler runs (BRIDGE_APP_SPEC S6.2: first rituals = handoff +
 * backlog sync). Each is `(ctx) => RitualResult`; the scheduler maps a config task's `ritual` field
 * to one of these. They degrade honestly: a hub-dependent ritual reports "skipped" when the 3080 has
 * no hub credential yet, rather than failing the run.
 *
 * COST POLICY (2026-06-07, owner directive):
 *  - routine tier (Haiku)  : polling, status checks, acknowledgements, handoff summaries
 *  - default tier (Sonnet) : env tasks with real tool work, meeting coordination
 *  - council tier (Opus)   : code review inside council meetings only
 * Heavy work (large builds, research, long docs) is deferred to Cowork-Arke via the env channel.
 * Every ritual logs its token spend; the handoff rolls up a daily total for Mathieu to see.
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

// ---------------------------------------------------------------------------
// Daily token spend ledger -- each ritual appends here; handoff reads the total
// ---------------------------------------------------------------------------
interface SpendEntry { ritual: string; at: string; tier: string; model: string; input: number; output: number }
const SPEND_FILE = path.join('C:', 'Arke', 'bridge-app', '.sessions', 'daily-spend.jsonl');

function recordSpend(entry: SpendEntry): void {
  try {
    fs.mkdirSync(path.dirname(SPEND_FILE), { recursive: true });
    fs.appendFileSync(SPEND_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* non-fatal */ }
}

function readDailySpend(): { entries: SpendEntry[]; totalInput: number; totalOutput: number } {
  const todayKey = new Date().toISOString().slice(0, 10);
  const entries: SpendEntry[] = [];
  try {
    const lines = fs.readFileSync(SPEND_FILE, 'utf8').split('\n').filter(Boolean);
    for (const l of lines) {
      try { const e = JSON.parse(l) as SpendEntry; if (e.at.startsWith(todayKey)) entries.push(e); } catch { /* skip bad lines */ }
    }
  } catch { /* file may not exist yet */ }
  return { entries, totalInput: entries.reduce((s, e) => s + e.input, 0), totalOutput: entries.reduce((s, e) => s + e.output, 0) };
}

/** Trim the ledger file so it never grows unbounded -- keep last 7 days. */
function pruneSpendFile(): void {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  try {
    const lines = fs.readFileSync(SPEND_FILE, 'utf8').split('\n').filter(Boolean);
    const kept = lines.filter((l) => { try { return (JSON.parse(l) as SpendEntry).at >= cutoff; } catch { return false; } });
    fs.writeFileSync(SPEND_FILE, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
  } catch { /* non-fatal */ }
}

/** Count non-directive tasks executed today from the spend ledger (for daily cap). */
function todayExecutionCount(): number {
  const todayKey = new Date().toISOString().slice(0, 10);
  try {
    return fs.readFileSync(SPEND_FILE, 'utf8').split('\n').filter(Boolean).filter((l) => {
      try {
        const e = JSON.parse(l) as SpendEntry;
        return e.at.startsWith(todayKey) && e.ritual.startsWith('env-poll:') && !e.ritual.endsWith(':directive');
      } catch { return false; }
    }).length;
  } catch { return 0; }
}

/**
 * Day-close handoff -- the agent reads the council repo's handoff + agenda and its own recent work,
 * then writes an updated DAILY_HANDOFF.md. This is the v1 close ritual, now run by the agent itself
 * instead of a Cowork engineer. Uses the tool loop (read + write), so it is fully self-contained.
 *
 * COST TIER: routine (Haiku). Handoffs are concise factual summaries; no deep reasoning required.
 * Cap: 6 iterations max -- read 2 files + write 1 is all that's needed; prevents runaway exploration.
 */
export const handoff: Ritual = async ({ agent, councilRepo, log }) => {
  const target = path.join(councilRepo, 'DAILY_HANDOFF.md');
  const agenda = path.join(councilRepo, 'COUNCIL_AGENDA.md');
  const session = agent.newSession();

  // Include today's token spend so Mathieu can see the bill curve.
  pruneSpendFile();
  const spend = readDailySpend();
  const spendNote = spend.entries.length
    ? `\n\nToday's 3080 token spend (before this handoff run): ${spend.totalInput} input + ${spend.totalOutput} output tokens across ${spend.entries.length} ritual call(s). Detail: ${JSON.stringify(spend.entries.map(e => ({ r: e.ritual, tier: e.tier, in: e.input, out: e.output })))}`
    : '\n\nNo 3080 API calls recorded yet today.';

  const prompt =
    `Daily close ritual. Read these two files: ${target} and ${agenda}. `
    + `Then write an updated day-close handoff to ${target}. Keep it concise and factual: today's date, `
    + `what changed today, current state of the v2 build, open items, and anything to raise with Mathieu. `
    + `Preserve any still-relevant content. Include a "## Daily token spend (3080)" section with this data:${spendNote}. `
    + `Use the write_file tool to save it. Then reply with a one-line summary.`;
  const r = await agent.act(session, prompt, { tier: 'routine', maxTokens: 2048, maxIterations: 6 });
  recordSpend({ ritual: 'handoff', at: new Date().toISOString(), tier: 'routine', model: agent.cfg.models.routine, input: r.usage.input, output: r.usage.output });
  log(`handoff: ${r.toolCalls} tool calls, ${r.usage.input}+${r.usage.output} tokens (routine/Haiku)`);
  return { ok: fs.existsSync(target), summary: r.text.slice(0, 200) || 'handoff written' };
};

/**
 * Backlog sync -- mirror the hub's canonical living backlog to a local file so the standalone always
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

/**
 * Env-channel poll -- claim queued tasks the hub holds for this agent and execute each through the
 * tool loop (gated + audited), then report the result.
 *
 * COST-SAFE REDESIGN (2026-06-08):
 *
 *  1. APPROVAL GATE: Non-directive tasks only execute if payload.approved === true is set by the
 *     sender. Without it, the task is acknowledged but NOT executed. This is the primary guard.
 *
 *  2. DAILY TASK CAP: ENV_POLL_MAX_TASKS_PER_DAY (default 5). When the cap is hit, remaining tasks
 *     get an ack-only reply; cap resets at midnight.
 *
 *  3. DRY-RUN MODE: ENV_POLL_DRY_RUN=true -- claims, logs, reports without executing.
 *
 *  4. ENV_POLL_ENABLED=true must be set (off by default -- the cost-pause guard).
 *
 * KIND TIERING:
 *  - directive        --> routine/Haiku, ack-only, no tools (always safe, no approval needed)
 *  - deploy / apply   --> default/Sonnet, max 12 tool calls / 4096 tokens
 *  - tool-task / other --> default/Sonnet, max 10 tool calls / 4096 tokens
 */
function tierForKind(kind: string): { tier: 'routine' | 'default' | 'council'; maxTokens: number; maxIterations: number; maxToolCalls: number; toolFree: boolean } {
  if (kind === 'directive') return { tier: 'routine', maxTokens: 600, maxIterations: 1, maxToolCalls: 0, toolFree: true };
  if (kind === 'deploy' || kind === 'apply') return { tier: 'default', maxTokens: 4096, maxIterations: 10, maxToolCalls: 12, toolFree: false };
  return { tier: 'default', maxTokens: 4096, maxIterations: 10, maxToolCalls: 10, toolFree: false };
}

export const envPoll: Ritual = async ({ agent, hub, log }) => {
  // Guard 0: env-poll disabled by default; must be explicitly re-enabled.
  if (process.env.ENV_POLL_ENABLED !== 'true') {
    return { ok: true, skipped: true, summary: 'skipped: ENV_POLL_ENABLED not set (cost-pause; set ENV_POLL_ENABLED=true to re-enable)' };
  }
  if (!hub.envConfigured()) return { ok: true, skipped: true, summary: 'skipped: no hub member secret on this machine yet' };

  const dryRun = process.env.ENV_POLL_DRY_RUN === 'true';
  const maxTasksPerDay = parseInt(process.env.ENV_POLL_MAX_TASKS_PER_DAY ?? '5', 10);
  if (dryRun) log('env-poll: DRY-RUN mode -- tasks claimed and logged but NOT executed');

  const tasks = await hub.getEnvTasks();
  const queued = tasks.filter((t) => t.status === 'queued');
  if (!queued.length) return { ok: true, summary: 'no queued env tasks' };

  const HEAVY_GUARD =
    '\n\nIMPORTANT (cost policy): do NOT undertake large builds, refactors, research, or long documents here -- '
    + 'that work belongs on Cowork-Arke. Prefer applying or deploying already-finished work. If this task '
    + 'needs heavy building, do minimal safe steps or none and report that it should be re-queued to Cowork-Arke.';

  let done = 0;
  for (const t of queued) {
    if (!(await hub.claimEnvTask(t.id))) continue; // optimistic claim; skip if another poller won

    const tiering = tierForKind(t.kind);
    const approved = (t.payload as any)?.approved === true;
    const needsApproval = !tiering.toolFree && !approved;

    // Guard 1: dry-run.
    if (dryRun) {
      const msg = `[dry-run] Would ${tiering.toolFree ? 'ack' : (needsApproval ? 'hold-for-approval' : 'execute')} task ${t.id} (${t.kind}) tier=${tiering.tier}`;
      await hub.reportEnvTask(t.id, 'done', msg);
      log(msg);
      continue;
    }

    // Guard 2: daily cap (directives exempt).
    if (!tiering.toolFree) {
      const execCount = todayExecutionCount();
      if (execCount >= maxTasksPerDay) {
        const msg = `DAILY CAP REACHED (${execCount}/${maxTasksPerDay} tasks today). Task ${t.id} (${t.kind}) deferred -- retry tomorrow or increase ENV_POLL_MAX_TASKS_PER_DAY.`;
        await hub.reportEnvTask(t.id, 'error', msg);
        log(`env-poll: ${msg}`);
        break;
      }
    }

    const session = agent.newSession();
    try {
      let reply: string, toolCalls = 0, usage: { input: number; output: number };

      if (tiering.toolFree) {
        // Directive: always safe, no approval needed.
        const prompt =
          `You received a ${t.kind} from ${t.from_actor} (id ${t.id}).\nTitle: ${t.title ?? '(none)'}\n`
          + `Payload: ${JSON.stringify(t.payload)}\n\nAcknowledge in 2-4 sentences. Do NOT act -- acknowledgement only.`;
        const turn = await agent.respond(session, prompt, tiering.tier, tiering.maxTokens);
        reply = turn.content; usage = turn.usage ?? { input: 0, output: 0 };

      } else if (needsApproval) {
        // Guard 3: approval gate.
        const prompt =
          `You received a ${t.kind} task from ${t.from_actor} (id ${t.id}) that lacks approval for auto-execution.\n`
          + `Title: ${t.title ?? '(none)'}\nPayload: ${JSON.stringify(t.payload)}\n\n`
          + `Summarise what this task would do and what specific approval is needed. Do NOT execute it. Reply in 3-5 sentences.`;
        const turn = await agent.respond(session, prompt, tiering.tier, tiering.maxTokens);
        reply = `[APPROVAL REQUIRED] ${turn.content}`; usage = turn.usage ?? { input: 0, output: 0 };
        await hub.reportEnvTask(t.id, 'done', reply);
        log(`env-poll: ${t.id} (${t.kind}) held for approval -- ${usage.input}+${usage.output} tokens`);
        recordSpend({ ritual: `env-poll:${t.kind}:held`, at: new Date().toISOString(), tier: tiering.tier, model: agent.cfg.models[tiering.tier], input: usage.input, output: usage.output });
        continue;

      } else {
        // Approved non-directive: execute with tool budget.
        const prompt =
          `You received an environment task from ${t.from_actor} (id ${t.id}, kind ${t.kind}).\n`
          + `Title: ${t.title ?? '(none)'}\nPayload: ${JSON.stringify(t.payload)}\n\n`
          + `Carry it out with your tools, within your permissions, then give a concise report.${HEAVY_GUARD}`;
        const r = await agent.act(session, prompt, { tier: tiering.tier, maxTokens: tiering.maxTokens, maxIterations: tiering.maxIterations, maxToolCalls: tiering.maxToolCalls });
        reply = r.text; toolCalls = r.toolCalls; usage = r.usage;
      }

      recordSpend({ ritual: `env-poll:${t.kind}`, at: new Date().toISOString(), tier: tiering.tier, model: agent.cfg.models[tiering.tier], input: usage.input, output: usage.output });
      await hub.reportEnvTask(t.id, 'done', reply || '(no report)');
      done++;
      log(`env-poll: completed ${t.id} (${t.kind}) tier=${tiering.tier} -- ${toolCalls} tool calls, ${usage.input}+${usage.output} tokens`);
    } catch (e) {
      await hub.reportEnvTask(t.id, 'error', String((e as Error).message));
      log(`env-poll: ${t.id} errored -- ${(e as Error).message}`);
    }
  }
  return { ok: true, summary: done ? `executed ${done} env task(s)` : 'tasks held/deferred or no claimable tasks' };
};

export const RITUALS: Record<string, Ritual> = { handoff, 'backlog-sync': backlogSync, 'env-poll': envPoll };
