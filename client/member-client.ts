/**
 * Per-agent member client (contract §2/§4; BRIDGE_APP_SPEC "product for three users").
 *
 * One process per agent, scoped to its own config — it can ONLY touch the project and voice that
 * config names (owner's security layer, mechanical). Built by Arke-Cowork on the proven spine
 * (protocol/consent/brain, test-room green); reviewed + deployed by Arke-3080.
 *
 * Commands:
 *   sync                full consent-gated incremental brain upload to the member's OWN voice,
 *                       then commit + verify the voice's independently recomputed brainVersion
 *   verify              compare local brainVersion vs the voice's, no upload
 *   transcript <id>     download a meeting transcript from the hub, verify transcriptSha256, save
 *   poll                list env-channel tasks waiting for this member on the hub (read-only)
 *
 * Usage:  tsx client/member-client.ts <command> --config <path-to-config.json>
 * Secrets: NEVER in the config file — the config names the env vars that hold them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { transcriptHash, CONTRACT_VERSION, type ChunkWithBody, type Chunk } from '../src/protocol.js';
import { loadConsent, ConsentViolation } from '../src/consent.js';
import { buildUpload, diffAgainst } from '../src/brain.js';

export interface ClientConfig {
  member: string;            // project id: zen-ai | biblevoice | architect-council
  displayName: string;       // Nova | Logos | Arke
  projectRoot: string;       // absolute path to the local project (the brain's source of truth)
  consentPath: string;       // absolute path to consent.json (contract §5)
  voiceBaseUrl: string;      // the member's OWN server, e.g. https://zen-ai.net
  hubBaseUrl: string;        // https://architectscouncil.com
  secretEnv: string;         // name of the env var holding this member's bridge secret
  inboxDir?: string;         // where downloaded transcripts land (default <projectRoot>/council-inbox)
  maxBatchBytes?: number;    // upload batch size (default ~1.5MB)
}

const die = (msg: string): never => { console.error(`[client] ${msg}`); process.exit(1); };

function loadConfig(file: string): { cfg: ClientConfig; secret: string } {
  if (!fs.existsSync(file)) die(`config not found: ${file}`);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as ClientConfig;
  for (const k of ['member', 'displayName', 'projectRoot', 'consentPath', 'voiceBaseUrl', 'hubBaseUrl', 'secretEnv'] as const) {
    if (!cfg[k]) die(`config missing required field: ${k}`);
  }
  const secret = process.env[cfg.secretEnv] || '';
  if (!secret) die(`secret env var ${cfg.secretEnv} is empty — set it before running (never put it in the config)`);
  return { cfg, secret };
}

async function call(base: string, p: string, secret: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(base.replace(/\/+$/, '') + p, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-bridge-secret': secret, ...(init.headers || {}) },
  });
  const text = await r.text();
  let body: any; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

/** Group chunks into batches under maxBatchBytes so no single request balloons. */
function batches(send: ChunkWithBody[], maxBytes: number): ChunkWithBody[][] {
  const out: ChunkWithBody[][] = [];
  let cur: ChunkWithBody[] = []; let size = 0;
  for (const c of send) {
    if (cur.length && size + c.bytes > maxBytes) { out.push(cur); cur = []; size = 0; }
    cur.push(c); size += c.bytes;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function cmdSync(cfg: ClientConfig, secret: string): Promise<void> {
  const consent = loadConsent(cfg.consentPath);
  let upload;
  try {
    upload = buildUpload(cfg.projectRoot, cfg.member, cfg.displayName, consent, new Date().toISOString());
  } catch (e) {
    if (e instanceof ConsentViolation) die(`UPLOAD ABORTED — ${e.message}. Nothing was sent. Fix the file or tune consent.json allowList.`);
    throw e;
  }
  const { manifest, chunks, excludedByPolicy } = upload!;
  console.log(`[client] ${cfg.displayName}: ${chunks.length} shareable chunks (${excludedByPolicy.length} excluded by policy), local brainVersion ${manifest.brainVersion.slice(0, 18)}…`);

  // What does the voice already hold? (absent endpoint -> treat as empty, full upload)
  let remote: Pick<Chunk, 'path' | 'sha256'>[] = [];
  try { remote = (await call(cfg.voiceBaseUrl, '/api/bridge/brain-chunks', secret)).chunks ?? []; }
  catch { console.log('[client] voice has no brain-chunks endpoint or empty brain — full upload'); }

  const diff = diffAgainst(chunks, remote);
  console.log(`[client] diff: send ${diff.send.length}, delete ${diff.deletePaths.length}, unchanged ${diff.unchanged}`);

  const max = cfg.maxBatchBytes ?? 1_500_000;
  const groups = batches(diff.send, max);
  for (let i = 0; i < groups.length; i++) {
    await call(cfg.voiceBaseUrl, '/api/bridge/brain-upload', secret, {
      method: 'POST',
      body: JSON.stringify({ send: groups[i], deletePaths: i === 0 ? diff.deletePaths : [] }),
    });
    console.log(`[client] batch ${i + 1}/${groups.length} accepted`);
  }

  const commit = await call(cfg.voiceBaseUrl, '/api/bridge/brain-commit', secret, {
    method: 'POST', body: JSON.stringify({ manifest }),
  });
  const remoteVersion = String(commit.brainVersion || '');
  if (remoteVersion !== manifest.brainVersion) {
    die(`INTEGRITY MISMATCH — voice recomputed ${remoteVersion.slice(0, 18)}… but local is ${manifest.brainVersion.slice(0, 18)}…  The voice must not be used until resynced.`);
  }
  console.log(`[client] ✓ COMMITTED + VERIFIED — voice independently recomputed the same brainVersion. ${cfg.displayName} is fully represented.`);
}

async function cmdVerify(cfg: ClientConfig, secret: string): Promise<void> {
  const consent = loadConsent(cfg.consentPath);
  const { manifest } = buildUpload(cfg.projectRoot, cfg.member, cfg.displayName, consent, new Date().toISOString());
  const v = await call(cfg.voiceBaseUrl, '/api/bridge/brain-version', secret);
  const match = v.brainVersion === manifest.brainVersion;
  console.log(`[client] local  ${manifest.brainVersion}`);
  console.log(`[client] voice  ${v.brainVersion} (updated ${v.updatedAt || '?'})`);
  console.log(match ? '[client] ✓ in sync' : '[client] ✗ OUT OF SYNC — run sync before the next meeting');
  if (!match) process.exit(2);
}

async function cmdTranscript(cfg: ClientConfig, secret: string, meetingId: string): Promise<void> {
  if (!meetingId) die('usage: transcript <meetingId>');
  const t = await call(cfg.hubBaseUrl, `/api/council/meeting/${encodeURIComponent(meetingId)}/transcript`, secret);
  const computed = transcriptHash(t.turns || []);
  if (computed !== t.header?.transcriptSha256) {
    die(`TRANSCRIPT HASH MISMATCH — header says ${String(t.header?.transcriptSha256).slice(0, 18)}…, local recompute is ${computed.slice(0, 18)}…  Do not trust this record; re-download or escalate to Mathieu.`);
  }
  const dir = cfg.inboxDir || path.join(cfg.projectRoot, 'council-inbox');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `meeting-${meetingId.slice(0, 8)}.json`);
  fs.writeFileSync(file, JSON.stringify(t, null, 2));
  console.log(`[client] ✓ transcript verified (${(t.turns || []).length} turns, hash match) -> ${file}`);
  console.log('[client] RAW copy delivered — your architect evaluates it locally (the hub records; the architects interpret).');
}

async function cmdPoll(cfg: ClientConfig, secret: string): Promise<void> {
  const d = await call(cfg.hubBaseUrl, `/api/env/tasks?for=${encodeURIComponent(cfg.member)}`, secret);
  const tasks = d.tasks || [];
  if (!tasks.length) { console.log('[client] inbox empty'); return; }
  for (const t of tasks) console.log(`${t.id}  [${t.status}] (${t.priority}) from ${t.from_actor}: ${t.title || t.kind}`);
  console.log('[client] read-only listing — act on these from your own architect session, never automatically.');
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const cfgIdx = rest.indexOf('--config');
  const cfgPath = cfgIdx >= 0 ? rest[cfgIdx + 1] : 'client-config.json';
  const args = rest.filter((_, i) => i !== cfgIdx && i !== cfgIdx + 1);
  const { cfg, secret } = loadConfig(cfgPath);
  console.log(`[client] agent=${cfg.displayName} (${cfg.member}) contract=${CONTRACT_VERSION}`);
  if (cmd === 'sync') return cmdSync(cfg, secret);
  if (cmd === 'verify') return cmdVerify(cfg, secret);
  if (cmd === 'transcript') return cmdTranscript(cfg, secret, args[0]);
  if (cmd === 'poll') return cmdPoll(cfg, secret);
  die('usage: member-client.ts <sync|verify|transcript <id>|poll> --config <file>');
}
main().catch((e) => die(e instanceof Error ? e.message : String(e)));
