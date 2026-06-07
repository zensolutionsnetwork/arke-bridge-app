/**
 * Scheduler smoke test — proves the daemon's logic deterministically with an injected clock (no real
 * waiting), then runs the real handoff ritual once against a SCRATCH repo (never the live files).
 *
 *   A. mechanism: catch-up fires a missed close, never double-fires, fires again next day, survives a
 *      restart (state on disk), and interval + non-catch-up grace behave correctly
 *   B. ritual: the handoff ritual reads + writes a DAILY_HANDOFF.md in a scratch council repo
 *
 * Run: npm run scheduler-smoke
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Audit } from './audit.js';
import { Scheduler, type SchedTask } from './scheduler.js';
import type { Schedule } from './schedule.js';
import { defaultConfig } from './config.js';
import { Agent } from './core.js';
import { handoff } from './rituals.js';
import { HubClient } from './hub.js';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SCRATCH = path.join(ROOT, '.scratch', 'sched');

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = '') => { ok ? (pass++, console.log(`  ✓ ${label}`)) : (fail++, console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)); };

// Toronto is UTC-4 in June, so 06:NN UTC = 02:NN local.
const at = (utc: string) => new Date(utc);
const audit = new Audit(path.join(SCRATCH, 'audit.log'));

function counterTask(id: string, schedule: Schedule, counts: Record<string, number>): SchedTask {
  return { id, schedule, run: async () => { counts[id] = (counts[id] || 0) + 1; return { ok: true, summary: 'ran' }; } };
}

async function mechanism(): Promise<void> {
  console.log('▸ A. mechanism (injected clock)');
  const counts: Record<string, number> = {};
  let nowRef = at('2026-06-08T06:30:00Z'); // local 02:30 — past the 02:00 close, box "just woke up"
  const statePath = path.join(SCRATCH, 'state-daily.json');
  fs.rmSync(statePath, { force: true });
  const daily: Schedule = { kind: 'daily', at: '02:00', tz: 'America/Toronto', catchUp: true };

  const s1 = new Scheduler({ tasks: [counterTask('close', daily, counts)], statePath, audit, clock: () => nowRef });
  await s1.tick();
  check('catch-up fires a missed 02:00 close at 02:30', counts.close === 1, `count=${counts.close}`);
  await s1.tick();
  check('does not double-fire later the same day', counts.close === 1, `count=${counts.close}`);

  nowRef = at('2026-06-09T06:30:00Z'); // next day 02:30
  await s1.tick();
  check('fires again the next day', counts.close === 2, `count=${counts.close}`);

  // Restart safety: a fresh Scheduler over the same state file must not refire the same day.
  const s2 = new Scheduler({ tasks: [counterTask('close', daily, counts)], statePath, audit, clock: () => nowRef });
  await s2.tick();
  check('restart does not refire an already-run day', counts.close === 2, `count=${counts.close}`);

  // Interval.
  const ic: Record<string, number> = {};
  let t = at('2026-06-08T00:00:00Z').getTime();
  const istate = path.join(SCRATCH, 'state-interval.json');
  fs.rmSync(istate, { force: true });
  const si = new Scheduler({ tasks: [counterTask('poll', { kind: 'interval', everyMs: 1000 }, ic)], statePath: istate, audit, clock: () => new Date(t) });
  await si.tick();
  check('interval fires on first tick', ic.poll === 1);
  await si.tick();
  check('interval does not fire before the period elapses', ic.poll === 1);
  t += 1100; await si.tick();
  check('interval fires after the period elapses', ic.poll === 2);

  // Non-catch-up grace: a missed close outside the grace window must NOT fire late.
  const gc: Record<string, number> = {};
  const grace: Schedule = { kind: 'daily', at: '02:00', tz: 'America/Toronto', catchUp: false, graceMinutes: 5 };
  let gNow = at('2026-06-08T06:30:00Z'); // 02:30, 30 min late
  const sg1 = new Scheduler({ tasks: [counterTask('strict', grace, gc)], statePath: path.join(SCRATCH, 'state-grace1.json'), audit, clock: () => gNow });
  fs.rmSync(path.join(SCRATCH, 'state-grace1.json'), { force: true });
  await sg1.tick();
  check('non-catch-up does NOT fire 30 min late', (gc.strict || 0) === 0);
  gNow = at('2026-06-08T06:03:00Z'); // 02:03, within 5-min grace
  const sg2 = new Scheduler({ tasks: [counterTask('strict', grace, gc)], statePath: path.join(SCRATCH, 'state-grace2.json'), audit, clock: () => gNow });
  fs.rmSync(path.join(SCRATCH, 'state-grace2.json'), { force: true });
  await sg2.tick();
  check('non-catch-up fires within the grace window', gc.strict === 1);

  check('an audit line was written for fired rituals', audit.tail(50).some((e) => e.tool.startsWith('ritual:')));
}

async function ritual(): Promise<void> {
  console.log('\n▸ B. handoff ritual (real, against a scratch repo)');
  const repo = path.join(SCRATCH, 'council-repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'DAILY_HANDOFF.md'), '# Daily handoff\n\n(placeholder from a previous day)\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'COUNCIL_AGENDA.md'), '# Agenda\n\n- [ ] v2 scheduler service being built today.\n', 'utf8');

  const cfg = defaultConfig();
  cfg.sessionsDir = path.join(SCRATCH, '.sessions');
  cfg.auditLog = path.join(SCRATCH, 'audit.log');
  cfg.councilRepo = repo;
  const agent = new Agent(cfg);

  const before = fs.readFileSync(path.join(repo, 'DAILY_HANDOFF.md'), 'utf8');
  const res = await handoff({ agent, hub: new HubClient(cfg.hub.baseUrl, {}), councilRepo: repo, log: (m) => console.log(`  ${m}`) });
  const after = fs.readFileSync(path.join(repo, 'DAILY_HANDOFF.md'), 'utf8');
  console.log(`  ritual summary: ${res.summary}`);
  check('handoff ritual reported ok', res.ok);
  check('DAILY_HANDOFF.md was rewritten by the ritual', after !== before && after.length > 40);
  await agent.shutdown();
}

async function main(): Promise<void> {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  await mechanism();
  // The live ritual proof makes a real API call — opt-in so the gate stays deterministic/reliable.
  if (process.env.SCHED_SMOKE_LIVE === '1') await ritual();
  else console.log('\n▸ B. handoff ritual — skipped (set SCHED_SMOKE_LIVE=1 to run the live proof)');
  console.log(`\n${'─'.repeat(60)}`);
  console.log(fail === 0
    ? `SCHEDULER: PASS — ${pass} checks. Rituals run 24/7 with catch-up; no missed closes, no double-fires.`
    : `SCHEDULER: FAIL — ${pass} passed, ${fail} failed.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(`\nSCHEDULER: FAIL — ${e.stack || e.message}`); process.exit(1); });
