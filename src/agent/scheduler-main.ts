/**
 * Scheduler daemon (BRIDGE_APP_SPEC §2/§6.2) — the long-lived process that runs the rituals 24/7.
 * Run: npm run scheduler. Meant to be kept alive by Windows Task Scheduler / NSSM / a service wrapper
 * (documented in the README); the process itself just ticks, fires, and logs.
 */
import { Agent } from './core.js';
import { loadConfig, type AgentConfig } from './config.js';
import { HubClient } from './hub.js';
import { RITUALS, type RitualContext } from './rituals.js';
import { Scheduler, type SchedTask } from './scheduler.js';
import type { Schedule } from './schedule.js';

export function buildScheduler(agent: Agent, cfg: AgentConfig, clock?: () => Date): Scheduler {
  const hub = new HubClient(cfg.hub.baseUrl, process.env[cfg.hub.adminTokenEnv]);
  const ctx: RitualContext = { agent, hub, councilRepo: cfg.councilRepo, log: (m) => console.log(`  ${m}`) };

  const tasks: SchedTask[] = cfg.scheduler.tasks.map((t) => {
    const ritual = RITUALS[t.ritual];
    if (!ritual) throw new Error(`unknown ritual '${t.ritual}' for task '${t.id}'`);
    const schedule: Schedule = t.everyMs
      ? { kind: 'interval', everyMs: t.everyMs }
      : { kind: 'daily', at: t.at || '00:00', tz: cfg.scheduler.timezone, catchUp: t.catchUp };
    return { id: t.id, enabled: t.enabled, schedule, run: () => ritual(ctx) };
  });

  return new Scheduler({ tasks, statePath: cfg.scheduler.statePath, audit: agent.audit, clock });
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const agent = new Agent(cfg);
  await agent.initTools();
  const sched = buildScheduler(agent, cfg);

  console.log(`⏱  scheduler up — ${agent.cfg.displayName} on ${cfg.scheduler.timezone}`);
  for (const t of cfg.scheduler.tasks) console.log(`   • ${t.id} (${t.ritual}) ${t.everyMs ? `every ${t.everyMs}ms` : `daily ${t.at}`}${t.enabled === false ? ' [disabled]' : ''}`);
  console.log(`   tick ${cfg.scheduler.tickMs}ms · state ${cfg.scheduler.statePath} · audit ${cfg.auditLog}`);

  sched.start(cfg.scheduler.tickMs);
  const shutdown = async () => { sched.stop(); await agent.shutdown(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run only when invoked directly (not when imported by the smoke test).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('scheduler-main.ts')) {
  main().catch((e) => { console.error(`scheduler failed: ${e.stack || e.message}`); process.exit(1); });
}
