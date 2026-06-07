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
test-room/        mock voice + mock receiving room + the harness runner
fixtures/         mock-agent-a (Nova), mock-agent-b (Logos), mock-agent-leaky (seeded secret)
```

## Run the gate

```
npm install
npm run test-room    # exit 0 = the family may connect (Arke first); nonzero = it may not
npm run typecheck
```

The test room proves, offline, with no live hub and no real secret:
1. upload brain → the voice's independently recomputed `brainVersion` matches the client's;
2. incremental sync sends only changed chunks;
3. a tampered transfer diverges the hash and is caught;
4. meeting → download transcript → `transcriptSha256` verifies locally; participants-only;
5. the consent gate aborts the whole upload loudly on a seeded fake secret, and deny globs drop
   files quietly before they ever reach the scanner.

## Not yet built (next, per BRIDGE_APP_SPEC §6)

Agent-core runtime (Agent SDK on `ANTHROPIC_API_KEY`, transcript persistence, memory import) ·
scheduler service + permission config · hub environment channel (`/api/env/*`) + poller · wiring
the consent gate into a real upload client against the live hub. The test room stays the gate: it
must be green before Nova, Logos, or Arke's voice connects.
