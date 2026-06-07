/**
 * Permission gate (BRIDGE_APP_SPEC §2: owner-defined, granted once in config, not per prompt).
 *
 * Three checks, fail-closed:
 *  - scope: the tool's category must be in `permissions.allowTools` (read/write/edit/shell/web/mcp).
 *  - path: file tools must resolve INSIDE one of `permissions.allowPaths` — no escaping the sandbox.
 *  - risky: delete/spend/publish must be explicitly listed in `permissions.riskyScopes`.
 *
 * Honesty clause: `shell` is intentionally powerful and the gate cannot fully sandbox what a command
 * does — granting 'shell' is a deliberate owner choice, and every command is audited. That tradeoff
 * is named in the spec (§5): blockage-free means no friction, not no rules.
 */
import path from 'node:path';
import type { AgentConfig } from './config.js';

export type Scope = 'read' | 'write' | 'edit' | 'shell' | 'web' | 'mcp' | 'delete' | 'spend' | 'publish';
const RISKY: Scope[] = ['delete', 'spend', 'publish'];

export interface Decision { allow: boolean; reason?: string }

export class Permissions {
  private allowPaths: string[];
  constructor(private cfg: AgentConfig) {
    this.allowPaths = cfg.permissions.allowPaths.map((p) => path.resolve(p).toLowerCase());
  }

  scopeAllowed(scope: Scope): Decision {
    if (RISKY.includes(scope)) {
      return this.cfg.permissions.riskyScopes.includes(scope)
        ? { allow: true }
        : { allow: false, reason: `risky scope '${scope}' not granted (add it to permissions.riskyScopes)` };
    }
    return this.cfg.permissions.allowTools.includes(scope)
      ? { allow: true }
      : { allow: false, reason: `scope '${scope}' not in permissions.allowTools` };
  }

  /** True if `target` resolves inside an allowed root. Guards against `..` traversal by resolving first. */
  pathAllowed(target: string): Decision {
    const abs = path.resolve(target).toLowerCase();
    const ok = this.allowPaths.some((root) => abs === root || abs.startsWith(root + path.sep));
    return ok ? { allow: true } : { allow: false, reason: `path outside allowPaths: ${target}` };
  }
}
