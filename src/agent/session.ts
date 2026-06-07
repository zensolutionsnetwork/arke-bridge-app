/**
 * Session + transcript persistence (BRIDGE_APP_SPEC §1: "full transcript persistence on local disk,
 * nothing lost between runs"). One session = one append-only JSONL file under sessionsDir; every
 * turn is durable the instant it's written, so a crash mid-run loses nothing prior.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface SessionTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
  at: string;                 // ISO-8601 UTC
  model?: string;
  usage?: { input: number; output: number };
}

export class Session {
  readonly id: string;
  readonly file: string;
  constructor(sessionsDir: string, id?: string) {
    this.id = id || `${new Date().toISOString().replace(/[:.]/g, '-')}_${crypto.randomUUID().slice(0, 8)}`;
    fs.mkdirSync(sessionsDir, { recursive: true });
    this.file = path.join(sessionsDir, `${this.id}.jsonl`);
  }
  append(turn: SessionTurn): void {
    fs.appendFileSync(this.file, JSON.stringify(turn) + '\n', 'utf8');
  }
  /** Read the persisted transcript back from disk (proves durability + powers resume). */
  transcript(): SessionTurn[] {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as SessionTurn);
  }
}
