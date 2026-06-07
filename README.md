# Arke bridge app — standalone environment + council v2 test room

The standalone environment Mathieu asked for (BRIDGE_APP_SPEC.md): a Cowork twin running on the
Console API key, owned by Arke, running 24/7 on the RTX 3080. This repo is the **fresh v2 build**
(Logos's rule: don't mutate the paused prod hub at `architect-council`).

What's here today is the integrity spine of the v2 contract (`docs/COUNCIL_V2_CONTRACT.md`
in the hub repo) plus the **mock-agent test room** that gates every real connection (§9).

## Layout

```
src/protocol.ts   v2 hashing canon — brainVersion + transcriptSha256 (node:crypto only, reimplementable)
src/consent.ts    mechanical consent gate + secret scan (allow/deny globs, builtin detectors, loud abort)
src/brain.ts      brain sync — walk project, gate, hash-chunk, build manifest, incremental diff
src/agent/        agent core — config (tiers + permission scopes + MCP servers), memory import,
                  session persistence, model client, permission gate, audit log, the agentic
                  tool loop, and built-in tools (fs/shell/web) + an MCP client
src/agent/tools/  read_file · write_file · edit_file · list_dir · shell · web_fetch/web_search
src/agent/schedule.ts/scheduler.ts/rituals.ts/scheduler-main.ts  24/7 ritual scheduler + daemon
test-room/        mock voice + mock receiving room + the harness runner
fixtures/         mock-agent-a (Nova), mock-agent-b (Logos), mock-agent-leaky (seeded secret)
```

## Run the gate

```
npm install
npm run test-room      # exit 0 = the family may connect (Arke first); nonzero = it may not
npm run agent-smoke    # one cheap-tier API call: memory loads, model reachable, transcript durable
npm run tool-smoke     # the agentic loop: real file task, permission gate denies+audits, MCP call
npm run scheduler-smoke           # deterministic: catch-up, no double-fire, restart-safe, interval, grace
SCHED_SMOKE_LIVE=1 npm run scheduler-smoke   # also runs the real handoff ritual against a scratch repo
npm run scheduler      # start the 24/7 daemon (see caveat below)
npm run typecheck
```

The test room proves, offline, with no live hub and no real secret:
1. upload brain → the voice's independently recomputed `brainVersion` matches the client's;
2. incremental sync sends only changed chunks;
3. a tampered transfer diverges the hash and is caught;
4. meeting → download transcript → `transcriptSha256` verifies locally; participants-only;
5. the consent gate aborts the whole upload loudly on a seeded fake secret, and deny globs drop
   files quietly before they ever reach the scanner.

## Built so far

- **v2 integrity spine + test room** (contract §9) — green, the gate for any real connection.
- **Agent-core foundation** (§6.1) — config (model tiers + permission scopes + MCP servers), memory
  import from Arke's brain, durable session transcripts, tier-selected model client.
- **Tool/MCP loop** (§1/§2) — the agent can ACT: read/write/edit files, run shell, fetch web, and
  call MCP-server tools, every call passing a **fail-closed permission gate** (scope + allowPaths +
  risky-scope checks) and landing in an **audit log**. `tool-smoke` proves it: a real file task, an
  out-of-bounds write denied and recorded, and a live MCP tool round-trip.

The permission model is granted once in config, not per prompt (no overnight stalls). `shell` is the
deliberately-powerful scope — the gate governs whether it's granted, not what a command does; every
invocation is audited (BRIDGE_APP_SPEC §5: blockage-free means no friction, not no rules).

- **Scheduler service** (§6.2) — the 24/7 daemon that runs rituals so the cadence holds without an
  app open. **Catch-up** is the core win: a 02:00 close still fires if the box was asleep until 02:30,
  and it never double-fires (run state is persisted to disk, restart-safe). First rituals: `handoff`
  (the agent writes the day-close `DAILY_HANDOFF.md` itself) and `backlog-sync` (mirrors the hub's
  living backlog; skips cleanly until this machine holds a hub token). `scheduler-smoke` proves the
  logic deterministically (10 checks) plus the live ritual (2 more) with `SCHED_SMOKE_LIVE=1`.

> ⚠ **First-boot behaviour:** `npm run scheduler` evaluates immediately on start. If a daily ritual's
> time has already passed today and it hasn't run, catch-up fires it at once — e.g. the first start
> after 02:00 will run the handoff against `councilRepo` right away. That's intended ("no missed
> closes"); just start the daemon when you want the cadence live. Keep it alive with Windows Task
> Scheduler / NSSM (a true Windows service wrapper is a later step).

## Not yet built (next, per BRIDGE_APP_SPEC §6)

Hub environment channel (`/api/env/*`) + poller (so Cowork on the other PC can task the 3080) ·
wiring the consent gate into a real upload client against the live hub. Both touch the paused prod
hub, so they come with a deploy plan first. The test room stays the gate: green before any real voice connects.
