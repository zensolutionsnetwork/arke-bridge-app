/**
 * Tool/MCP loop smoke test — proves the agent core can ACT, safely (BRIDGE_APP_SPEC §1/§2).
 *
 *   1. real task: the model uses write_file then read_file to create and verify a file on disk
 *   2. permission gate: a write outside allowPaths is denied and audited (fail-closed)
 *   3. MCP: a tool from a live stdio MCP server is discovered and callable through the same loop
 *
 * Uses the cheap tier — this checks plumbing, not reasoning depth. Run: npm run tool-smoke
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { defaultConfig } from './config.js';
import { Agent } from './core.js';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url))); // C:\Arke\bridge-app
const SCRATCH = path.join(ROOT, '.scratch');
const TARGET = path.join(SCRATCH, 'hello-from-arke.txt');

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = '') => { ok ? (pass++, console.log(`  ✓ ${label}`)) : (fail++, console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)); };

async function main(): Promise<void> {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });

  const cfg = defaultConfig();
  cfg.sessionsDir = path.join(SCRATCH, '.sessions');
  cfg.auditLog = path.join(SCRATCH, 'audit.log');
  // MCP fixture server, launched via node + the local tsx CLI (no PATH/npx assumptions).
  cfg.mcpServers = {
    fixture: { command: process.execPath, args: [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'test-room', 'mcp-fixture-server.ts')] },
  };

  const agent = new Agent(cfg);
  const registry = await agent.initTools();
  console.log(`tools: ${registry.all().map((t) => t.name).join(', ')}`);
  check('built-in tools present', ['read_file', 'write_file', 'edit_file', 'list_dir', 'shell', 'web_fetch'].every((n) => registry.get(n)));
  check('MCP tool discovered (mcp__fixture__echo)', !!registry.get('mcp__fixture__echo'));

  // 1) Real file task through the loop.
  console.log('\n▸ real task: write then read a file');
  const s1 = agent.newSession();
  const r1 = await agent.act(s1,
    `Create the file at exactly this path: ${TARGET}\nIts content must be exactly: COUNCIL-V2-OK\nThen read it back and tell me the exact content you read.`,
    { tier: 'routine', maxTokens: 1024 });
  console.log(`  iterations=${r1.iterations} toolCalls=${r1.toolCalls} tokens(in=${r1.usage.input},out=${r1.usage.output})`);
  console.log(`  final: ${r1.text.slice(0, 160)}`);
  check('file exists on disk', fs.existsSync(TARGET));
  check('file content is exactly COUNCIL-V2-OK', fs.existsSync(TARGET) && fs.readFileSync(TARGET, 'utf8').trim() === 'COUNCIL-V2-OK');
  check('used at least one tool call', r1.toolCalls >= 1);

  // 2) Permission gate: deny a write outside allowPaths.
  console.log('\n▸ permission gate: write outside allowPaths must be denied');
  const outside = path.join(os.tmpdir(), 'arke-should-not-exist.txt');
  fs.rmSync(outside, { force: true });
  const s2 = agent.newSession();
  await agent.act(s2,
    `Write the text "nope" to this exact path: ${outside}\nIf the tool is denied, just report that it was denied. Do not try any other location.`,
    { tier: 'routine', maxTokens: 512 });
  check('out-of-bounds file was NOT created', !fs.existsSync(outside));
  const audit = agent.audit.tail(50);
  check('a deny was recorded in the audit log', audit.some((e) => e.decision === 'deny'), `denies=${audit.filter((e) => e.decision === 'deny').length}`);

  // 3) MCP tool through the loop.
  console.log('\n▸ MCP: call the fixture echo tool through the loop');
  const s3 = agent.newSession();
  const r3 = await agent.act(s3,
    `Use the mcp__fixture__echo tool with text "ping-42" and tell me exactly what it returned.`,
    { tier: 'routine', maxTokens: 512 });
  console.log(`  final: ${r3.text.slice(0, 160)}`);
  const mcpCalled = agent.audit.tail(50).some((e) => e.tool === 'mcp__fixture__echo' && e.decision === 'allow');
  check('MCP echo tool was invoked through the loop', mcpCalled);
  check('model saw the fixture echo response', /ping-42/.test(r3.text));

  await agent.shutdown();
  console.log(`\n${'─'.repeat(60)}`);
  console.log(fail === 0
    ? `TOOL/MCP LOOP: PASS — ${pass} checks. The agent can act: files, shell-capable, web, MCP, gated + audited.`
    : `TOOL/MCP LOOP: FAIL — ${pass} passed, ${fail} failed.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(`\nTOOL/MCP LOOP: FAIL — ${e.stack || e.message}`); process.exit(1); });
