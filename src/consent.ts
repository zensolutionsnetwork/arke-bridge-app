/**
 * Mechanical consent gate (contract §4/§5, Logos's secret-scan pattern applied to brain uploads).
 *
 * Nothing leaves a project without passing its LOCAL consent manifest. The gate is enforced by
 * construction in the bridge app, not by honor: every candidate file must (a) match an allow glob
 * and no deny glob, then (b) survive the secret scan. A file that matches allow/deny yet carries a
 * secret aborts the WHOLE upload loudly — the member believed it shareable, so silence would be the
 * leak. Full-trust today is just a permissive manifest; the gate exists from day one for outsiders.
 *
 * The manifest is JSON here (`consent.json`) — same schema as the contract's YAML illustration, but
 * dependency-free and deterministically hashable so consentManifestVersion is reproducible.
 */
import fs from 'node:fs';
import { digest, type Hash } from './protocol.js';

export interface ConsentManifest {
  contractVersion: string;
  version: number;                 // bumped on every edit; its hash is recorded in each upload
  share: { allow: string[]; deny: string[] };
  secretScan: { blockPatterns?: string[]; allowList?: string[] }; // blockPatterns names built-ins to enable
  audience?: Record<string, string>;
}

/** Glob → RegExp. Supports `**` (any depth incl. `/`), `*` (within a segment), `?` (one char). */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; } // `**/` or `**`
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else if (c === '/') re += '/';
    else re += c;
  }
  return new RegExp(`^${re}$`);
}
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');
export function matchAny(path: string, globs: string[]): boolean {
  const p = norm(path);
  return globs.some((g) => globToRegExp(norm(g)).test(p));
}

/** Hash of the canonical manifest — pinned into every brain upload (contract §2/§5). */
export function consentManifestVersion(m: ConsentManifest): Hash {
  const canonical = JSON.stringify({
    contractVersion: m.contractVersion,
    version: m.version,
    share: { allow: [...m.share.allow].sort(), deny: [...m.share.deny].sort() },
    secretScan: { blockPatterns: [...(m.secretScan.blockPatterns ?? [])].sort(), allowList: [...(m.secretScan.allowList ?? [])].sort() },
    audience: m.audience ?? {},
  });
  return digest(canonical);
}

/** Built-in secret detectors, named so a manifest opts in by name (contract §5 blockPatterns). */
export const BUILTIN_PATTERNS: Record<string, RegExp> = {
  'hex-token-32': /\b[0-9a-fA-F]{32,}\b/,
  'anthropic-key': /\bsk-ant-[A-Za-z0-9_-]{8,}/,
  'openai-key': /\bsk-[A-Za-z0-9]{20,}/,
  'aws-access-key': /\bAKIA[0-9A-Z]{16}\b/,
  'slack-token': /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  'db-url': /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s'"]+/i,
  'pem-private-key': /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
  'private-doc-marker': /\b(?:CONFIDENTIAL|DO[\s-]?NOT[\s-]?SHARE|PRIVATE-?DOC)\b/,
};
const DEFAULT_PATTERNS = Object.keys(BUILTIN_PATTERNS);

export interface SecretHit { pattern: string; sample: string }
/** Scan content; a hit whose matched text appears in allowList is treated as a tuned false positive. */
export function scanForSecrets(content: string, m: ConsentManifest): SecretHit[] {
  const enabled = (m.secretScan.blockPatterns?.length ? m.secretScan.blockPatterns : DEFAULT_PATTERNS)
    .filter((name) => name in BUILTIN_PATTERNS);
  const allow = m.secretScan.allowList ?? [];
  const hits: SecretHit[] = [];
  for (const name of enabled) {
    const match = BUILTIN_PATTERNS[name].exec(content);
    if (match && !allow.some((a) => match[0].includes(a))) {
      const sample = match[0].length > 12 ? `${match[0].slice(0, 6)}…${match[0].slice(-2)}` : match[0];
      hits.push({ pattern: name, sample });
    }
  }
  return hits;
}

export class ConsentViolation extends Error {
  constructor(public path: string, public hits: SecretHit[]) {
    super(`consent gate BLOCKED ${path}: ${hits.map((h) => `${h.pattern}(${h.sample})`).join(', ')}`);
    this.name = 'ConsentViolation';
  }
}

export interface GateInput { path: string; content: string }
export interface GateResult {
  included: GateInput[];
  excludedByPolicy: string[]; // didn't match allow, or matched deny — quietly not shared
}

/**
 * Apply the gate. Throws ConsentViolation (loud abort) on the FIRST shareable-but-secret-bearing
 * file — the caller must abort the whole upload, never ship a partial brain past a tripped scanner.
 */
export function gate(files: GateInput[], m: ConsentManifest): GateResult {
  const included: GateInput[] = [];
  const excludedByPolicy: string[] = [];
  for (const f of files) {
    const p = norm(f.path);
    const shareable = matchAny(p, m.share.allow) && !matchAny(p, m.share.deny);
    if (!shareable) { excludedByPolicy.push(p); continue; }
    const hits = scanForSecrets(f.content, m);
    if (hits.length) throw new ConsentViolation(p, hits);
    included.push({ path: p, content: f.content });
  }
  return { included, excludedByPolicy };
}

export function loadConsent(file: string): ConsentManifest {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as ConsentManifest;
}
