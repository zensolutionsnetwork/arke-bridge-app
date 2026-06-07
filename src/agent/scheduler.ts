/**
 * The scheduler service (BRIDGE_APP_SPEC §2/§6.2) — the daemon that runs rituals 24/7 so the
 * family's cadence holds without an app being open. On every tick it asks each task "are you due?"
 * (catch-up aware), fires the due ones at most once per day/interval, records the run to a state
 * file (restart-safe: a reboot never double-fires or loses a pending close), and audits the outcome.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Schedule } from './schedule.js';
import { dailyDue, intervalDue } from './schedule.js';
import type { Audit } from './audit.js';
import type { RitualResult } from './rituals.js';

export interface SchedTask {
  id: string;
  schedule: Schedule;
  enabled?: boolean;
  run: () => Promise<RitualResult>;
}

interface TaskState { lastRunDate?: string; lastRunMs?: number }
type State = Record<string, TaskState>;

export interface Fired { id: string; at: string; result: RitualResult }

export class Scheduler {
  private state: State = {};
  private running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private clock: () => Date;

  constructor(private opts: { tasks: SchedTask[]; statePath: string; audit: Audit; clock?: () => Date }) {
    this.clock = opts.clock ?? (() => new Date());
    if (fs.existsSync(opts.statePath)) { try { this.state = JSON.parse(fs.readFileSync(opts.statePath, 'utf8')); } catch { this.state = {}; } }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.opts.statePath), { recursive: true });
    fs.writeFileSync(this.opts.statePath, JSON.stringify(this.state, null, 2), 'utf8');
  }

  /** Evaluate every task once; fire the due ones. Returns what fired (used by tests + logging). */
  async tick(): Promise<Fired[]> {
    const now = this.clock();
    const fired: Fired[] = [];
    for (const task of this.opts.tasks) {
      if (task.enabled === false || this.running.has(task.id)) continue;
      const st = this.state[task.id] ?? (this.state[task.id] = {});

      let stamp: { kind: 'daily'; date: string } | { kind: 'interval'; ms: number } | null = null;
      if (task.schedule.kind === 'daily') {
        const date = dailyDue(task.schedule, now, st);
        if (date) stamp = { kind: 'daily', date };
      } else {
        const ms = intervalDue(task.schedule, now, st);
        if (ms !== null) stamp = { kind: 'interval', ms };
      }
      if (!stamp) continue;

      // Record the run BEFORE executing so an overlapping tick or a crash can't double-fire it.
      if (stamp.kind === 'daily') st.lastRunDate = stamp.date; else st.lastRunMs = stamp.ms;
      this.persist();

      this.running.add(task.id);
      const startedAt = now.toISOString();
      try {
        const result = await task.run();
        this.opts.audit.write({ at: startedAt, tool: `ritual:${task.id}`, scope: 'mcp', decision: 'allow', ok: result.ok, summary: result.skipped ? 'skipped' : result.summary });
        fired.push({ id: task.id, at: startedAt, result });
      } catch (e) {
        const result: RitualResult = { ok: false, summary: `error: ${(e as Error).message}` };
        this.opts.audit.write({ at: startedAt, tool: `ritual:${task.id}`, scope: 'mcp', decision: 'allow', ok: false, error: (e as Error).message });
        fired.push({ id: task.id, at: startedAt, result });
      } finally {
        this.running.delete(task.id);
      }
    }
    return fired;
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, intervalMs);
    this.tick().catch(() => {}); // evaluate once immediately on boot (catches an overnight miss)
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
  snapshot(): State { return JSON.parse(JSON.stringify(this.state)); }
}
