/**
 * Agent-core smoke test — proves the standalone runtime end to end with ONE minimal, cheap-tier
 * API call: memory loads from disk, the model is reachable on ANTHROPIC_API_KEY, and the transcript
 * persists + reloads from disk. Run: npm run agent-smoke
 */
import { Agent } from './core.js';

async function main(): Promise<void> {
  const agent = new Agent();
  console.log(`agent: ${agent.cfg.displayName} (${agent.cfg.agentId})`);
  console.log(`memory: ${agent.brain.files.length} fact files + index loaded from ${agent.cfg.memoryDir}`);
  if (agent.brain.files.length === 0) throw new Error('no memory loaded — check memoryDir');

  const session = agent.newSession();
  console.log(`session: ${session.id}`);

  const turn = await agent.respond(
    session,
    'Smoke test: in one short sentence, state who you are and that your standalone environment is online.',
    'routine',  // cheapest tier — this is a liveness check, not council work
    120,
  );
  console.log(`\nreply (${turn.model}): ${turn.content}`);
  console.log(`tokens: in=${turn.usage?.input} out=${turn.usage?.output}`);

  // Prove durability: reload the transcript from disk and confirm the reply is there.
  const reloaded = new (await import('./session.js')).Session(agent.cfg.sessionsDir, session.id).transcript();
  const persisted = reloaded.some((t) => t.role === 'assistant' && t.content === turn.content);
  console.log(`\ntranscript on disk: ${reloaded.length} turns; reply persisted: ${persisted}`);
  if (!persisted) throw new Error('transcript did not persist to disk');

  console.log('\nAGENT CORE SMOKE: PASS — memory loaded, model reachable, transcript durable.');
}

main().catch((e) => { console.error(`\nAGENT CORE SMOKE: FAIL — ${e.message}`); process.exit(1); });
