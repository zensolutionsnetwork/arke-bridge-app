/**
 * Audit log (BRIDGE_APP_SPEC §2: "everything in an audit log Mathieu can read"). Append-only JSONL,
 * one line per tool invocation — what was attempted, whether the permission gate allowed it, and how
 * it ended. This is the owner's window into an unattended agent; it is written before AND after the
 * call so a crash mid-tool still leaves a trace of the attempt.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface AuditEntry {
  at: string;                 // ISO-8601 UTC
  session?: string;
  tool: string;
  scope: string;              // read | write | edit | shell | web | mcp | delete | ...
  decision: 'allow' | 'deny';
  reason?: string;            // why a deny happened
  summary?: string;           // short, non-secret description of the input
  ok?: boolean;               // outcome once the tool ran
  error?: string;
  ms?: number;
}

export class Audit {
  constructor(private file: string) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
  write(e: AuditEntry): void {
    try { fs.appendFileSync(this.file, JSON.stringify(e) + '\n', 'utf8'); } catch { /* never let auditing crash a run */ }
  }
  tail(n = 20): AuditEntry[] {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).slice(-n).map((l) => JSON.parse(l) as AuditEntry);
  }
}
