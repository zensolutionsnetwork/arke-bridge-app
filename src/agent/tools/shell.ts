/**
 * Shell tool — native command execution, no sandbox indirection (BRIDGE_APP_SPEC §2). This is the
 * deliberately-powerful scope: the gate governs WHETHER 'shell' is granted, not what a command does
 * once it runs, so every invocation is audited and a timeout bounds runaway processes.
 */
import { exec } from 'node:child_process';
import type { Tool } from './types.js';

const DEFAULT_TIMEOUT = 120_000;
const MAX_OUT = 60_000;

export const shell: Tool = {
  name: 'shell',
  scope: 'shell',
  description: 'Run a shell command on the host (PowerShell on Windows) and return combined stdout/stderr and the exit code.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run' },
      cwd: { type: 'string', description: 'Working directory (must be inside an allowed path)' },
      timeoutMs: { type: 'number', description: 'Optional timeout; default 120000' },
    },
    required: ['command'],
  },
  // The cwd is the path the gate checks; if omitted the loop substitutes the first allowed root.
  pathArg: (i) => i.cwd,
  run(i, ctx) {
    const cwd = i.cwd || ctx.cfg.permissions.allowPaths[0];
    const timeout = Math.min(Number(i.timeoutMs) || DEFAULT_TIMEOUT, 600_000);
    const shellExe = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
    return new Promise((resolve) => {
      exec(i.command, { cwd, timeout, shell: shellExe, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err && typeof (err as any).code === 'number' ? (err as any).code : err ? 1 : 0;
        let out = [stdout, stderr].filter(Boolean).join('\n').trim();
        if (out.length > MAX_OUT) out = out.slice(0, MAX_OUT) + `\n…[clipped]`;
        resolve({ content: `exit ${code}\n${out || '(no output)'}`, isError: code !== 0 });
      });
    });
  },
};
